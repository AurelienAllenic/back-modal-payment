require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

app.use(cors({
  origin: ["http://localhost:5173", "http://127.0.0.1:5173"]
}));
app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, quantity = 1, customerEmail, metadata = {} } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: quantity,
        },
      ],
      mode: "payment",
      success_url: `http://localhost:5173/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `http://localhost:5173/cancel`,
      customer_email: customerEmail || undefined,
      metadata,
    });

    // ← CHANGEMENT ICI : renvoie session.url au lieu de session.id
    res.json({ url: session.url });
  } catch (error) {
    console.error("Erreur Stripe :", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Serveur Stripe démarré sur le port ${PORT}`));