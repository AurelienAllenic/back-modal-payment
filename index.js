require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// 1. CORS : on ajoute ton domaine prod + TOUS les previews Vercel
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "https://modal-payment.vercel.app",
      // Cette ligne accepte TOUS les sous-domaines vercel.app (preview, branches, etc.)
      /.+\.vercel\.app$/,
    ],
    credentials: true,
  })
);

// 2. LIGNE ABSOLUMENT OBLIGATOIRE POUR QUE LE PREFLIGHT MARCHE SUR VERCEL
app.options("*", cors());

// Parse JSON
app.use(express.json());

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
      // Utilise l'origin réel du frontend (fonctionne en preview + prod)
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

// RETRIEVE SESSION
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

// Pour le local seulement
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Local: http://localhost:${PORT}`));

// LIGNE MAGIQUE N°1
module.exports = app;

// Si jamais Vercel a besoin d'une fonction handler (certains cas rares)
module.exports.handler = app;