// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Price IDs configuration
const PRICE_IDS = {
    monthly: 'price_1QMtsECcFkjlkIFGAmSwTHbX',
    annual: 'price_1QMttrCcFkjlkIFGQ3sSV7I0'
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
    },
    subscription_data: {      // Add this section
        metadata: {
            userId: userId,
            firebaseUID: userId
        }
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

        // Check subscription status
        app.post('/check-subscription-status', async (req, res) => {
            try {
                const { userId } = req.body;

                if (!userId) {
                    return res.status(400).json({ error: 'userId is required' });
                }

                logger.info('Checking subscription status for user:', { userId });

                // Get Firestore data
                const userDoc = await db.collection('users').doc(userId).get();
                if (!userDoc.exists) {
                    return res.status(404).json({ error: 'User not found' });
                }

                const userData = userDoc.data();
                logger.debug('User data from Firestore:', userData);

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
        
// Cancel subscription
app.post('/cancel-subscription', async (req, res) => {
    try {
        const { email, userId } = req.body;
        
        // Add debug logging
        console.log('Received cancellation request:', {
            hasEmail: !!email,
            hasUserId: !!userId,
            email: email,
            userId: userId,
            body: req.body
        });

        if (!email) {
            console.log('Missing email in request');
            return res.status(400).json({ error: 'Email is required' });
        }

        // First try to find customer by email
        logger.info('Looking up customer by email:', { email });
        const customers = await stripe.customers.list({
            email: email.toLowerCase(),
            limit: 1
        });

        // If no customer found by email, try Firebase UID
        let customer = customers.data[0];
        if (!customer && userId) {
            logger.info('No customer found by email, trying Firebase UID:', { userId });
            const customersByUID = await stripe.customers.search({
                query: `metadata['firebaseUID']:'${userId}'`,
                limit: 1
            });
            customer = customersByUID.data[0];
        }

        console.log('Customer search results:', {
            customerFound: !!customer,
            customerId: customer?.id
        });

        if (!customer) {
            console.log('No customer found for:', { email, userId });
            return res.status(404).json({ error: 'Customer not found' });
        }

        // Find active subscription
        const subscriptions = await stripe.subscriptions.list({
            customer: customer.id,
            status: 'active',
            limit: 1
        });

        console.log('Subscription search results:', {
            subscriptionsFound: subscriptions.data.length,
            firstSubscriptionId: subscriptions.data[0]?.id
        });

        if (subscriptions.data.length === 0) {
            console.log('No active subscription found for customer:', customer.id);
            return res.status(404).json({ error: 'No active subscription found' });
        }

        // Cancel the subscription
        const subscription = await stripe.subscriptions.update(
            subscriptions.data[0].id,
            { cancel_at_period_end: true }
        );

        // Update Firestore if userId provided
        if (userId) {
            await db.collection('users').doc(userId).update({
                'subscription.status': 'cancelled',
                'subscription.cancelAtPeriodEnd': true,
                'subscription.canceledAt': admin.firestore.FieldValue.serverTimestamp(),
                'subscription.endDate': new Date(subscription.current_period_end * 1000)
            });
        }

        console.log('Subscription cancelled successfully:', {
            subscriptionId: subscription.id,
            customer: customer.id,
            email: email
        });

        res.json({
            success: true,
            subscription: {
                id: subscription.id,
                currentPeriodEnd: subscription.current_period_end,
                cancelAtPeriodEnd: subscription.cancel_at_period_end
            }
        });

    } catch (error) {
        console.error('Detailed cancellation error:', {
            message: error.message,
            type: error.type,
            code: error.code,
            stack: error.stack
        });
        res.status(500).json({
            error: error.message,
            code: error.code || 'UNKNOWN_ERROR'
        });
    }
});



        
        // Stripe webhook handler
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        logger.info('Received webhook event');
        
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
        
        logger.info('Webhook event type:', event.type);

        try {
            switch (event.type) {
case 'customer.subscription.created':
case 'customer.subscription.updated':
    const subscription = event.data.object;
    // First try to get userId from the subscription's metadata
    let userId = subscription.metadata?.userId || subscription.metadata?.firebaseUID;
    
    if (!userId) {
        try {
            // If no metadata, try to get the original checkout session
            const sessions = await stripe.checkout.sessions.list({
                subscription: subscription.id,
                limit: 1
            });
            if (sessions.data.length > 0) {
                userId = sessions.data[0].client_reference_id;
            }
        } catch (error) {
            logger.error('Error fetching checkout session:', error);
        }
    }
    
    logger.info('Session data:', {
        sessionId: subscription.id,
        clientReferenceId: userId
    });
    
    logger.info('Subscription metadata:', subscription.metadata);
                    
                    logger.info('Processing subscription event:', {
                        subscriptionId: subscription.id,
                        userId: userId,
                        status: subscription.status
                    });

                    if (!userId) {
                        throw new Error('No Firebase UID found in subscription metadata');
                    }

                    await db.collection('users').doc(userId).update({
                        'subscription.status': subscription.status,
                        'subscription.tier': 'pro',
                        'subscription.stripeSubscriptionId': subscription.id,
                        'subscription.currentPeriodEnd': new Date(subscription.current_period_end * 1000),
                        'subscription.cancelAtPeriodEnd': subscription.cancel_at_period_end,
                        'subscription.lastUpdated': admin.firestore.FieldValue.serverTimestamp(),
                        'subscription.pendingUpgrade': false
                    });
                    
                    logger.info('Successfully updated user subscription in Firebase');
                    break;

                case 'customer.subscription.deleted':
                    const canceledSubscription = event.data.object;
                    const canceledUserId = canceledSubscription.metadata.firebaseUID;

                    logger.info('Processing subscription deletion:', {
                        subscriptionId: canceledSubscription.id,
                        userId: canceledUserId
                    });

                    if (!canceledUserId) {
                        throw new Error('No Firebase UID found in subscription metadata');
                    }

                    await db.collection('users').doc(canceledUserId).update({
                        'subscription.status': 'inactive',
                        'subscription.tier': 'basic',
                        'subscription.stripeSubscriptionId': null,
                        'subscription.currentPeriodEnd': null,
                        'subscription.cancelAtPeriodEnd': false,
                        'subscription.lastUpdated': admin.firestore.FieldValue.serverTimestamp()
                    });
                    
                    logger.info('Successfully updated canceled subscription in Firebase');
                    break;

                default:
                    logger.info(`Unhandled event type: ${event.type}`);
            }

            res.json({ received: true });
        } catch (error) {
            logger.error('Webhook processing failed:', {
                error: error.message,
                stack: error.stack,
                eventType: event.type,
                subscriptionId: event.data.object.id
            });
            // Send 200 even on processing error to prevent retries
            res.json({ received: true, error: error.message });
        }
    } catch (err) {
        logger.error('Webhook signature verification failed:', err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
});

// URL configuration check
app.get('/check-urls', (req, res) => {
    res.json({
        success_url: `https://cryptosnapshot.net/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `https://cryptosnapshot.net/canceled-payment?session_id={CHECKOUT_SESSION_ID}`,
        webhook_url: `${process.env.BASE_URL}/webhook`,
        stripe_configured: !!process.env.STRIPE_SECRET_KEY,
        webhook_secret_configured: !!process.env.STRIPE_WEBHOOK_SECRET
    });
});

return app;
    } catch (error) {
        logger.error('App initialization failed:', error);
        throw error;
    }
};        

// Start server with async initialization
initializeApp()
    .then(app => {
        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
        });
    })
    .catch(error => {
        logger.error('Server failed to start:', error);
        process.exit(1);
    });        

