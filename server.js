// 1. First all requires
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// 2. Stripe initialization (only once)
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// 3. Debug logging
console.log('STRIPE_SECRET_KEY exists:', !!process.env.STRIPE_SECRET_KEY);
console.log('STRIPE_SECRET_KEY length:', process.env.STRIPE_SECRET_KEY?.length);
console.log('STRIPE_SECRET_KEY prefix:', process.env.STRIPE_SECRET_KEY?.substring(0, 7));

// 4. Express app creation and middleware
const app = express();

app.use(cors({
    origin: ['https://cryptosnapshot.net', 'http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// 5. Firebase initialization
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// Test endpoint for Stripe
app.get('/test-stripe', async (req, res) => {
    try {
        // Try a simple Stripe API call
        const test = await stripe.customers.list({ limit: 1 });
        res.json({ success: true, message: 'Stripe connection successful' });
    } catch (error) {
        console.error('Stripe test error:', {
            message: error.message,
            type: error.type,
            stack: error.stack
        });
        res.status(500).json({ error: error.message, type: error.type });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { priceId, userId, email } = req.body;

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
                userId: userId
            }
        });

        res.json({ sessionId: session.id });
    } catch (error) {
        console.error('Checkout session error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Check subscription status
app.post('/check-subscription-status', async (req, res) => {
    try {
        console.log('Checking subscription status for request:', req.body);
        const { userId } = req.body;

        if (!userId) {
            console.log('No userId provided');
            return res.status(400).json({ error: 'userId is required' });
        }

        console.log('Fetching Firestore data for user:', userId);
        const userDoc = await admin.firestore().collection('users').doc(userId).get();
        const userData = userDoc.data();
        console.log('Firestore data:', userData);

        console.log('Searching for Stripe customer');
        const customer = await stripe.customers.search({
            query: `metadata['firebaseUID']:'${userId}'`,
        });
        console.log('Stripe customer search result:', customer);

        if (customer.data.length > 0) {
            console.log('Found Stripe customer, checking subscriptions');
            const subscriptions = await stripe.subscriptions.list({
                customer: customer.data[0].id,
                status: 'active',
                limit: 1,
            });
            console.log('Subscription data:', subscriptions);

            if (subscriptions.data.length > 0) {
                const response = {
                    active: true,
                    status: 'active',
                    currentPeriodEnd: subscriptions.data[0].current_period_end
                };
                console.log('Sending response:', response);
                res.json(response);
                return;
            }
        }

        const response = {
            active: false,
            status: 'inactive',
            currentPeriodEnd: null
        };
        console.log('No active subscription found. Sending response:', response);
        res.json(response);

    } catch (error) {
        console.error('Detailed subscription check error:', {
            message: error.message,
            stack: error.stack,
            type: error.type,
            raw: error.raw
        });
        res.status(500).json({
            error: error.message,
            type: error.type,
            details: error.raw
        });
    }
});

// Cancel subscription
app.post('/cancel-subscription', async (req, res) => {
    try {
        const { userId } = req.body;
        const customer = await stripe.customers.search({
            query: `metadata['firebaseUID']:'${userId}'`,
        });

        if (customer.data.length > 0) {
            const subscriptions = await stripe.subscriptions.list({
                customer: customer.data[0].id,
                status: 'active',
                limit: 1,
            });

            if (subscriptions.data.length > 0) {
                const subscription = await stripe.subscriptions.update(
                    subscriptions.data[0].id,
                    { cancel_at_period_end: true }
                );

                res.json({ success: true, subscription });
                return;
            }
        }

        res.status(404).json({ error: 'No active subscription found' });
    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Add this test endpoint
app.get('/check-urls', (req, res) => {
    res.json({
        success_url: `https://cryptosnapshot.net/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `https://cryptosnapshot.net/canceled-payment?session_id={CHECKOUT_SESSION_ID}`,
        message: 'Current configured URLs in deployed server'
    });
});

// Keep your existing PORT and listen code
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});