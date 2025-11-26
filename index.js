require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

// CORS – accepte TOUS les domaines vercel.app (prod + previews + branches)
const allowedOrigins = [
  "https://modal-payment.vercel.app",
  // tous les sous-domaines vercel.app → c'est ÇA qui manquait avant
  /^(https?:\/\/)[a-zA-Z0-9-]+\.vercel\.app$/,
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.some(o => origin.match(o) || allowedOrigins.includes(origin))) {
      callback(null, origin); // on renvoie l'origine exacte
    } else {
      console.log("CORS bloqué →", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // préflight → obligatoire

app.use(express.json());

app.get("/", (req, res) => res.send("Backend Stripe OK"));

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { priceId, quantity = 1, customerEmail, metadata = {} } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity }],
      mode: "payment",
      success_url: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/cancel`,
      customer_email: customerEmail || undefined,
      metadata,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/retrieve-session", async (req, res) => {
  // ton code retrieve ici si tu veux
});

// Lancement local (ignoré sur Vercel)
app.listen(4242, () => console.log("Local OK"));

// LIGNE QUI FAIT QUE VERCEL COMPREND TON EXPRESS
module.exports = app;