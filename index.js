require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// ────────────────── CORS ──────────────────
const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "https://modal-payment.vercel.app",
    // Accepte TOUS les sous-domaines vercel.app (preview + prod + branches)
    /.+\.vercel\.app$/,
  ],
  credentials: true,
  optionsSuccessStatus: 200,
};

// Middleware créé une seule fois → c’est ÇA qui fait que le preflight marche
const corsMiddleware = cors(corsOptions);

app.use(corsMiddleware);
app.options("*", corsMiddleware); // ← même instance → header présent à 100%

// ────────────────── BODY ──────────────────
app.use(express.json());

// ────────────────── ROUTES ──────────────────
app.get("/", (req, res) => {
  res.send("Backend Stripe Vercel OK");
});

// CREATE CHECKOUT SESSION
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { priceId, quantity = 1, customerEmail, metadata = {} } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity }],
      mode: "payment",
      success_url: `${req.headers.origin || "https://modal-payment.vercel.app"}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin || "https://modal-payment.vercel.app"}/cancel`,
      customer_email: customerEmail || undefined,
      metadata,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erreur création session Stripe :", error);
    res.status(500).json({ error: error.message });
  }
});

// RETRIEVE SESSION → TA ROUTE EST BIEN LÀ
app.get("/api/retrieve-session", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: "session_id manquant" });

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["line_items", "customer_details"],
    });

    res.json(session);
  } catch (error) {
    console.error("Erreur récupération session :", error);
    res.status(500).json({ error: error.message });
  }
});

// ────────────────── LOCAL + VERCEL ──────────────────
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Local: http://localhost:${PORT}`));

// LIGNES MAGIQUES OBLIGATOIRES
module.exports = app;
module.exports.handler = app; // au cas où Vercel soit capricieux