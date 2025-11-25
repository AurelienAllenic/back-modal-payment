require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// Middleware
app.use(cors({
  origin: ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174"] // au cas où tu changes de port
}));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Welcome to the backend of modal payment");
});

// CREATE CHECKOUT SESSION
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { priceId, quantity = 1, customerEmail, metadata = {} } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity,
        },
      ],
      mode: "payment",
      success_url: `http://localhost:5173/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `http://localhost:5173/cancel`,
      customer_email: customerEmail || undefined,
      metadata, // On passe tel quel → plus de écrasement !
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erreur création session Stripe :", error);
    res.status(500).json({ error: error.message });
  }
});

// RETRIEVE SESSION (pour la page /success)
app.get("/retrieve-session", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) {
      return res.status(400).json({ error: "session_id manquant" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id, {
      expand: ["line_items", "customer_details"],
    });

    res.json(session);
  } catch (error) {
    console.error("Erreur récupération session :", error);
    res.status(500).json({ error: error.message });
  }
});

// Lancement du serveur
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Backend Stripe prêt → http://localhost:${PORT}`);
});