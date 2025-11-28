require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const Stripe = require("stripe");
const { Resend } = require("resend"); // ← Ajout Resend

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY); // ← Clé API Resend

const app = express();

// ────────────────── CORS ──────────────────
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "https://modal-payment.vercel.app",
      /\.vercel\.app$/,
    ],
    credentials: true,
  })
);

// ────────────────── BODY PARSING ──────────────────
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ────────────────── MONGODB ──────────────────
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connecté"))
  .catch((err) => {
    console.error("MongoDB erreur:", err);
    process.exit(1);
  });

// ────────────────── SCHEMA ORDER ──────────────────
const orderSchema = new mongoose.Schema(
  {
    stripeSessionId: { type: String, required: true, unique: true },
    orderNumber: { type: String, unique: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "paid",
    },
    amountTotal: { type: Number, required: true },
    currency: { type: String, default: "eur" },
    customer: {
      name: String,
      email: { type: String, lowercase: true },
      phone: String,
    },
    type: {
      type: String,
      enum: ["traineeship", "show", "courses"],
      required: true,
    },
    metadata: mongoose.Schema.Types.Mixed,
    event: { title: String, place: String, date: String, hours: String },
  },
  { timestamps: true }
);

const Order = mongoose.model("Order", orderSchema);

// ────────────────── FONCTION POUR GÉNÉRER LE CONTENU EMAIL ──────────────────
const getOrderDetailsHtml = (order) => {
  const m = order.metadata || {};
  const e = order.event || {};

  if (order.type === "traineeship") {
    return `
      <h3 style="color:#333;">Stage réservé</h3>
      <p><strong>${e.title || "Stage"}</strong></p>
      <p>${e.place} • ${e.date} • ${e.hours}</p>
      <p>Participants : ${m.nombreParticipants || "-"}</p>
    `;
  }
  if (order.type === "show") {
    return `
      <h3 style="color:#333;">Spectacle réservé</h3>
      <p><strong>${e.title || "Spectacle"}</strong></p>
      <p>${e.place} • ${e.date} • ${e.hours}</p>
      <p>Adultes : ${m.adultes || 0} × 15 €</p>
      <p>Enfants : ${m.enfants || 0} × 10 €</p>
    `;
  }
  if (order.type === "courses") {
    return `
      <h3 style="color:#333;">Cours réservé</h3>
      <p>Catégorie d’âge : ${m.ageGroup || "-"}</p>
      <p>Type : ${m.courseType === "essai" ? "Cours d’essai" : "Cours réguliers"}</p>
    `;
  }
  return "<p>Réservation confirmée.</p>";
};

// ────────────────── ROUTES ──────────────────
app.get("/", (req, res) => res.send("Backend OK"));

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { priceId, quantity = 1, customerEmail, metadata = {} } = req.body;
    if (!priceId) return res.status(400).json({ error: "priceId manquant" });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity }],
      mode: "payment",
      success_url: `${
        process.env.FRONTEND_URL || "https://modal-payment.vercel.app"
      }/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${
        process.env.FRONTEND_URL || "https://modal-payment.vercel.app"
      }/cancel`,
      customer_email: customerEmail || undefined,
      metadata,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erreur création session:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/retrieve-session", async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: "session_id manquant" });

    const order = await Order.findOne({ stripeSessionId: session_id });
    if (!order) return res.status(404).json({ error: "Commande non trouvée" });

    res.json({
      id: order.stripeSessionId,
      orderNumber: order.orderNumber,
      amount_total: order.amountTotal,
      currency: order.currency,
      customer_details: {
        name: order.customer.name || "Anonyme",
        email: order.customer.email || null,
        phone: order.customer.phone || null,
      },
      metadata: order.metadata || {},
      type: order.type,
      event: order.event || null,
    });
  } catch (error) {
    console.error("Erreur retrieve-session:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/orders", async ( copie, res) => {
  try {
    const orders = await Order.find({})
      .sort({ createdAt: -1 })
      .select("-__v")
      .lean();

    res.json({
      success: true,
      count: orders.length,
      data: orders.map((order) => ({
        id: order._id,
        orderNumber: order.orderNumber || "—",
        stripeSessionId: order.stripeSessionId,
        date: new Date(order.createdAt).toLocaleDateString("fr-FR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
        amount: (order.amountTotal / 100).toFixed(2) + " €",
        customer: order.customer?.name || "Anonyme",
        email: order.customer?.email || "—",
        phone: order.customer?.phone || "—",
        type: order.type,
        eventTitle: order.event?.title || "—",
        status: order.paymentStatus,
      })),
    });
  } catch (error) {
    console.error("Erreur /api/orders :", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ────────────────── WEBHOOK ──────────────────
app.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    console.log(
      "Webhook reçu →",
      session.id,
      "| payment_status:",
      session.payment_status
    );

    // Vérifier si déjà traitée
    const exists = await Order.findOne({ stripeSessionId: session.id });
    if (exists) {
      console.log("Commande déjà existante →", session.id);
      return res.json({ received: true });
    }

    const metadata = session.metadata || {};
    const eventData = metadata.eventData
      ? JSON.parse(metadata.eventData || "null")
      : null;
    const singleEvent = Array.isArray(eventData) ? eventData[0] : eventData;

    // Génération du numéro de commande (100 % fiable sur Vercel)
    const year = new Date().getFullYear();
    const count = await Order.countDocuments({
      createdAt: { $gte: new Date(`${year}-01-01`) },
    });
    const orderNumber = `CMD-${year}-${String(count + 1).padStart(5, "0")}`;

    // Création de la commande
    const order = await new Order({
      stripeSessionId: session.id,
      orderNumber,
      amountTotal: session.amount_total || 0,
      currency: session.currency || "eur",
      paymentStatus: "paid",
      customer: {
        name:
          metadata.nom || session.customer_details?.name || "Anonyme",
        email:
          metadata.email || session.customer_details?.email || null,
        phone:
          metadata.telephone || session.customer_details?.phone || null,
      },
      type: metadata.type,
      metadata,
      event: singleEvent
        ? {
            title: singleEvent.title || "Événement",
            place: singleEvent.place || "Lieu inconnu",
            date: singleEvent.date || "Date inconnue",
            hours: singleEvent.hours || "Horaire inconnu",
          }
        : null,
    }).save();

    console.log(
      "COMMANDE CRÉÉE →",
      session.id,
      "| Numéro:",
      orderNumber
    );

    // ────────────────── ENVOI DES EMAILS (Resend) ──────────────────
    const confirmationUrl = `${
      process.env.FRONTEND_URL || "https://modal-payment.vercel.app"
    }/success?session_id=${session.id}`;
    const amountFormatted = (order.amountTotal / 100).toFixed(2);

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 12px; background:#fafafa;">
        <h2 style="color:#28a745; text-align:center;">Réservation confirmée !</h2>
        <p>Bonjour ${order.customer.name},</p>
        <p>Nous avons bien reçu votre paiement. Voici le récapitulatif de votre réservation :</p>

        <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
          <p><strong>Numéro de commande :</strong> ${order.orderNumber}</p>
          <p><strong>Montant payé :</strong> ${amountFormatted} €</p>
        </div>

        ${getOrderDetailsHtml(order)}

        <div style="text-align:center; margin:30px 0;">
          <a href="${confirmationUrl}" style="background:#28a745; color:white; padding:14px 28px; text-decoration:none; border-radius:8px; font-weight:bold; font-size:16px;">
            Voir ma réservation
          </a>
        </div>

        <p>À très bientôt !</p>
        <hr style="border:none; border-top:1px solid #eee; margin:30px 0;">
        <small style="color:#888;">Ceci est un email automatique – ne pas répondre.</small>
      </div>
    `;

    try {
      // Email client
      if (order.customer.email) {
        await resend.emails.send({
          from: "Modal Danse <onboarding@resend.dev>", // À changer après vérification du domaine sur Resend
          to: order.customer.email,
          subject: `Confirmation – ${order.orderNumber}`,
          html: emailHtml,
        });
      }

      // Email admin (toi)
      await resend.emails.send({
        from: "Modal Danse <onboarding@resend.dev>",
        to: process.env.ADMIN_EMAIL,
        subject: `Nouvelle commande – ${order.orderNumber}`,
        html: `
          <h2>Nouvelle réservation !</h2>
          <p><strong>Numéro :</strong> ${order.orderNumber}</p>
          <p><strong>Client :</strong> ${order.customer.name} – ${order.customer.email}</p>
          <p><strong>Téléphone :</strong> ${order.customer.phone || "-"}</p>
          <p><strong>Montant :</strong> ${amountFormatted} €</p>
          <p><strong>Type :</strong> ${order.type}</p>
          ${getOrderDetailsHtml(order)}
          <p><a href="${confirmationUrl}">Voir la réservation</a></p>
        `,
      });

      console.log("Emails envoyés avec succès (client + admin)");
    } catch (emailErr) {
      console.error("Erreur envoi email Resend :", emailErr);
      // On ne bloque pas le webhook si l'email échoue
    }
  }

  res.json({ received: true });
});

// ────────────────── LANCEMENT ──────────────────
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Serveur prêt sur le port ${PORT}`));

module.exports = app;