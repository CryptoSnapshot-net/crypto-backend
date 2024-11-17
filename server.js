// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Logger setup
const logger = {
    info: (msg, data) => console.log(`[INFO] ${msg}`, data || ''),
    error: (msg, err) => console.error(`[ERROR] ${msg}`, {
        message: err.message,
        stack: err.stack,
        type: err.type,
        raw: err.raw || ''
    })
};

// Initialize Firebase Admin globally
let db = null;
const initializeFirebase = () => {
    if (!admin.apps.length) {
        try {
            const credentials = {
                type: "service_account",
                project_id: process.env.FIREBASE_PROJECT_ID,
                private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                client_email: process.env.FIREBASE_CLIENT_EMAIL,
                auth_uri: "https://accounts.google.com/o/oauth2/auth",
                token_uri: "https://oauth2.googleapis.com/token",
                auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
                client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL}`
            };

            admin.initializeApp({
                credential: admin.credential.cert(credentials)
            });
            
            db = admin.firestore();
            logger.info('Firebase Admin initialized successfully');
        } catch (error) {
            logger.error('Firebase initialization error:', error);
            throw error;
        }
    }
    return db;
};

// Initialize Express app
const app = express();

// Configure CORS
app.use(cors({
    origin: ['https://cryptosnapshot.net', 'http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Initialize Firebase and get db reference
db = initializeFirebase();

// Regular JSON parsing for normal routes
app.use((req, res, next) => {
    if (req.path === '/webhook') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: new Date().toISOString(),
        stripe: !!process.env.STRIPE_SECRET_KEY,
        firebase: !!db,
        firebaseInitialized: admin.apps.length > 0
    });
});

// Check subscription status
app.post('/check-subscription-status', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }

        logger.info('Checking subscription status for user:', { userId });

        if (!db) {
            logger.error('Database not initialized');
            return res.status(500).json({ error: 'Database connection error' });
        }

        // Get Firestore data
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userData = userDoc.data();
        logger.info('User data from Firestore:', userData);

        // Search for Stripe customer
        const customers = await stripe.customers.search({
            query: `metadata['firebaseUID']:'${userId}'`,
            limit: 1
        });

        if (customers.data.length > 0) {
            const customer = customers.data[0];
            
            // Get active subscriptions
            const subscriptions = await stripe.subscriptions.list({
                customer: customer.id,
                status: 'active',
                limit: 1
            });

            if (subscriptions.data.length > 0) {
                const subscription = subscriptions.data[0];

                // Update Firestore with current status
                await db.collection('users').doc(userId).update({
                    'subscription.status': 'active',
                    'subscription.tier': 'pro',
                    'subscription.stripeSubscriptionId': subscription.id,
                    'subscription.currentPeriodEnd': new Date(subscription.current_period_end * 1000),
                    'subscription.lastChecked': admin.firestore.FieldValue.serverTimestamp()
                });

                return res.json({
                    active: true,
                    status: 'active',
                    currentPeriodEnd: subscription.current_period_end,
                    subscriptionId: subscription.id
                });
            }
        }

        // No active subscription found
        await db.collection('users').doc(userId).update({
            'subscription.status': 'inactive',
            'subscription.tier': 'basic',
            'subscription.lastChecked': admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            active: false,
            status: 'inactive',
            currentPeriodEnd: null
        });

    } catch (error) {
        logger.error('Subscription status check failed:', error);
        res.status(500).json({
            error: error.message,
            code: error.code || 'UNKNOWN_ERROR'
        });
    }
});

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { priceId, userId, email } = req.body;

        if (!priceId || !userId || !email) {
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['priceId', 'userId', 'email']
            });
        }

        if (!db) {
            logger.error('Database not initialized');
            return res.status(500).json({ error: 'Database connection error' });
        }

        logger.info('Creating checkout session:', { userId, email });

        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{
                price: priceId,
                quantity: 1,
            }],
            success_url: `https://cryptosnapshot.net/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `https://cryptosnapshot.net/canceled-payment?session_id={CHECKOUT_SESSION_ID}`,
            client_reference_id: userId,
            customer_email: email,
            metadata: {
                userId: userId,
                firebaseUID: userId
            }
        });

        // Update Firestore with pending subscription
        await db.collection('users').doc(userId).update({
            'subscription.pendingUpgrade': true,
            'subscription.checkoutSessionId': session.id,
            'subscription.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ sessionId: session.id });

    } catch (error) {
        logger.error('Checkout session creation failed:', error);
        res.status(500).json({
            error: error.message,
            code: error.code || 'UNKNOWN_ERROR'
        });
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});

module.exports = app;
