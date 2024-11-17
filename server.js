// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Price IDs configuration
const priceIds = {
    monthly: 'price_1QMDn1CcFkjlkIFGklYtjFft',
    annual: 'price_1QMDprCcFkjlkIFGagJhphnp'
};

// Enhanced logging utility
const logger = {
    info: (msg, data) => console.log(`[INFO] ${msg}`, data || ''),
    error: (msg, err) => console.error(`[ERROR] ${msg}`, {
        message: err.message,
        stack: err.stack,
        type: err.type,
        raw: err.raw || ''
    }),
    debug: (msg, data) => console.log(`[DEBUG] ${msg}`, data || '')
};

// Global database reference
let db = null;

// Initialize Firebase Admin
const initializeFirebase = () => {
    if (!admin.apps.length) {
        try {
            // Handle private key formatting
            let privateKey = process.env.FIREBASE_PRIVATE_KEY;
            
            if (privateKey.includes('\\n')) {
                privateKey = privateKey.replace(/\\n/g, '\n');
            }
            
            if (privateKey.startsWith('"') && privateKey.endsWith('"')) {
                privateKey = privateKey.slice(1, -1);
            }

            const credentials = {
                type: "service_account",
                project_id: process.env.FIREBASE_PROJECT_ID,
                private_key: privateKey,
                client_email: process.env.FIREBASE_CLIENT_EMAIL,
                auth_uri: "https://accounts.google.com/o/oauth2/auth",
                token_uri: "https://oauth2.googleapis.com/token",
                auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
                client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL}`
            };

            logger.info('Initializing Firebase with project:', credentials.project_id);

            admin.initializeApp({
                credential: admin.credential.cert(credentials)
            });
            
            db = admin.firestore();
            logger.info('Firebase Admin initialized successfully');
            
            // Verify database connection
            return db.collection('users').limit(1).get()
                .then(() => {
                    logger.info('Firebase connection verified');
                    return db;
                })
                .catch(error => {
                    logger.error('Firebase connection test failed:', error);
                    throw error;
                });
        } catch (error) {
            logger.error('Firebase initialization error:', error);
            throw error;
        }
    }
    return Promise.resolve(db);
};

// Initialize Express app with async setup
const initializeApp = async () => {
    try {
        // Initialize Firebase first
        db = await initializeFirebase();
        
        const app = express();

        // Configure CORS
        app.use(cors({
            origin: ['https://cryptosnapshot.net', 'http://localhost:3000'],
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization']
        }));

        // Parse JSON for all routes except webhook
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

        // Test Stripe connection
        app.get('/test-stripe', async (req, res) => {
            try {
                const test = await stripe.customers.list({ limit: 1 });
                logger.info('Stripe connection test successful');
                res.json({ success: true, message: 'Stripe connection successful' });
            } catch (error) {
                logger.error('Stripe connection test failed:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // Create checkout session
  // Create checkout session
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { priceId, userId, email } = req.body;
        
        // Add debug logging
        console.log('Received request with:', { priceId, userId, email });
        console.log('Current PRICE_IDS config:', PRICE_IDS);

        if (!priceId || !userId || !email) {
            console.log('Missing required fields:', { 
                hasPriceId: !!priceId, 
                hasUserId: !!userId, 
                hasEmail: !!email 
            });
            return res.status(400).json({
                error: 'Missing required fields',
                required: ['priceId', 'userId', 'email']
            });
        }

        // Validate priceId
        const validPriceIds = Object.values(PRICE_IDS);
        console.log('Validating price ID:', {
            received: priceId,
            valid: validPriceIds,
            isValid: validPriceIds.includes(priceId)
        });

        if (!validPriceIds.includes(priceId)) {
            return res.status(400).json({
                error: 'Invalid priceId',
                validPriceIds
            });
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

        // Update Firestore
        await db.collection('users').doc(userId).update({
            'subscription.pendingUpgrade': true,
            'subscription.checkoutSessionId': session.id,
            'subscription.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ sessionId: session.id });

    } catch (error) {
        console.error('Detailed checkout error:', {
            message: error.message,
            type: error.type,
            code: error.code
        });
        res.status(500).json({
            error: error.message,
            code: error.code || 'UNKNOWN_ERROR'
        });
    }
});
