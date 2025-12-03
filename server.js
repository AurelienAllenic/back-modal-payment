require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const Stripe = require("stripe");
const { Resend } = require("resend");
const Traineeship = require('./models/Traineeship');
const Show = require('./models/Show');
const classicCourse = require('./models/ClassicCourse');
const trialCourse = require('./models/TrialCourse');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

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

// ────────────────── FONCTION CONTENU EMAIL ──────────────────
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
      <p>Catégorie d'âge : ${m.ageGroup || "-"}</p>
      <p>Type : ${m.courseType === "essai" ? "Cours d'essai" : "Cours réguliers"}</p>
    `;
  }
  return "<p>Réservation confirmée.</p>";
};

// ────────────────── ROUTES ──────────────────
app.get("/", (req, res) => res.send("Backend OK"));

// Création de la session Stripe
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { items, priceId, quantity = 1, customerEmail, metadata = {} } = req.body;

    let lineItems = [];

    // Support nouveau format (items[]) ET ancien format (priceId)
    if (items && Array.isArray(items) && items.length > 0) {
      lineItems = items.map((item) => ({
        price: item.price,
        quantity: item.quantity || 1,
      }));
    } else if (priceId) {
      lineItems = [{ price: priceId, quantity }];
    } else {
      return res.status(400).json({ error: "priceId ou items manquant" });
    }

    if (lineItems.length === 0) {
      return res.status(400).json({ error: "Aucun article à payer" });
    }

    // Calcul du nombre de places demandées
    const requestedPlaces = lineItems.reduce((sum, item) => sum + item.quantity, 0);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: lineItems,
      mode: "payment",
      success_url: `${
        process.env.FRONTEND_URL || "https://modal-payment.vercel.app"
      }/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${
        process.env.FRONTEND_URL || "https://modal-payment.vercel.app"
      }/cancel`,
      customer_email: customerEmail || undefined,
      metadata: {
        ...metadata,
        requestedPlaces: requestedPlaces.toString(),
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erreur création session:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Récupérer une session
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

// Liste des commandes
app.get("/api/orders", async (req, res) => {
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

// ────────────────── WEBHOOK STRIPE ──────────────────
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

    console.log("Webhook reçu →", session.id, "| payment_status:", session.payment_status);

    // Vérifier si la commande existe déjà
    const exists = await Order.findOne({ stripeSessionId: session.id });
    if (exists) {
      console.log("Commande déjà existante →", session.id);
      return res.json({ received: true });
    }

    const metadata = session.metadata || {};
    const eventData = metadata.eventData ? JSON.parse(metadata.eventData || "null") : null;
    const singleEvent = Array.isArray(eventData) ? eventData[0] : eventData;

    // Génération du numéro de commande
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
        name: metadata.nom || session.customer_details?.name || "Anonyme",
        email: metadata.email || session.customer_details?.email || null,
        phone: metadata.telephone || session.customer_details?.phone || null,
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

    console.log("✅ COMMANDE CRÉÉE →", session.id, "| Numéro:", orderNumber);

    // ────────────────── DÉCRÉMENTER LES PLACES DISPONIBLES ──────────────────
    const type = metadata.type;
    const eventId = metadata.eventId;
    const requestedPlaces = parseInt(metadata.requestedPlaces || "1");

    try {
      if (type === "traineeship" && eventId) {
        await Traineeship.findByIdAndUpdate(eventId, {
          $inc: { numberOfPlaces: -requestedPlaces }
        });
        console.log(`✅ Stage ${eventId}: -${requestedPlaces} places`);
      }

      if (type === "show" && eventId) {
        await Show.findByIdAndUpdate(eventId, {
          $inc: { numberOfPlaces: -requestedPlaces }
        });
        console.log(`✅ Show ${eventId}: -${requestedPlaces} places`);
      }

      if (type === "classic" && eventId) {
        await classicCourse.findByIdAndUpdate(eventId, {
          $inc: { numberOfPlaces: -requestedPlaces }
        });
        console.log(`✅ Cours classique ${eventId}: -${requestedPlaces} places`);
      }

      if (type === "trial" && eventId) {
        await trialCourse.findByIdAndUpdate(eventId, {
          $inc: { numberOfPlaces: -requestedPlaces }
        });
        console.log(`✅ Cours d'essai ${eventId}: -${requestedPlaces} places`);
      }
    } catch (updateError) {
      console.error("❌ Erreur mise à jour des places:", updateError.message);
    }

    // ────────────────── ENVOI DES EMAILS ──────────────────
    const clientEmail = order.customer.email || session.customer_details?.email || metadata.email || null;

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
          <p><strong>Numéro de commande :</strong> ${orderNumber}</p>
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
      if (clientEmail && clientEmail.trim() !== "") {
        await resend.emails.send({
          from: "Modal Danse <hello@resend.dev>",
          to: clientEmail.trim(),
          subject: `Confirmation – ${order.orderNumber}`,
          html: emailHtml,
        });
        console.log("✅ EMAIL CLIENT ENVOYÉ →", clientEmail.trim());
      }

      // Email admin
      if (process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.trim() !== "") {
        await resend.emails.send({
          from: "Modal Danse <hello@resend.dev>",
          to: process.env.ADMIN_EMAIL,
          subject: `Nouvelle commande – ${order.orderNumber}`,
          html: `
            <h2>Nouvelle réservation !</h2>
            <p><strong>Numéro :</strong> ${order.orderNumber}</p>
            <p><strong>Client :</strong> ${order.customer.name} – ${clientEmail || "non renseigné"}</p>
            <p><strong>Téléphone :</strong> ${order.customer.phone || "-"}</p>
            <p><strong>Montant :</strong> ${amountFormatted} €</p>
            <p><strong>Type :</strong> ${order.type}</p>
            ${getOrderDetailsHtml(order)}
            <p><a href="${confirmationUrl}">Voir la réservation</a></p>
          `,
        });
        console.log("✅ EMAIL ADMIN ENVOYÉ");
      }
    } catch (emailErr) {
      console.error("❌ ERREUR RESEND :", emailErr.message);
    }
  }

  res.json({ received: true });
});

// ────────────────── ROUTES TRAINEESHIPS ──────────────────
app.get("/api/traineeships", async (req, res) => {
  try {
    const stages = await Traineeship.find({}).sort({ date: 1 }).lean();
    res.json(stages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/traineeships/:id", async (req, res) => {
  try {
    const stage = await Traineeship.findById(req.params.id).lean();
    if (!stage) return res.status(404).json({ error: "Stage introuvable" });
    res.json(stage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ────────────────── ROUTES SHOWS ──────────────────
app.get("/api/shows", async (req, res) => {
  try {
    const shows = await Show.find({}).sort({ date: 1 }).lean();
    res.json(shows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/shows/:id", async (req, res) => {
  try {
    const show = await Show.findById(req.params.id).lean();
    if (!show) return res.status(404).json({ error: "Spectacle introuvable" });
    res.json(show);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ────────────────── ROUTES CLASSIC COURSES ──────────────────
app.get("/api/classic-courses", async (req, res) => {
  try {
    const courses = await classicCourse.find({}).sort({ date: 1 }).lean();
    res.json(courses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/classic-courses/:id", async (req, res) => {
  try {
    const course = await classicCourse.findById(req.params.id).lean();
    if (!course) return res.status(404).json({ error: "Cours introuvable" });
    res.json(course);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ────────────────── ROUTES TRIAL COURSES ──────────────────
app.get("/api/trial-courses", async (req, res) => {
  try {
    const courses = await trialCourse.find({}).sort({ date: 1 }).lean();
    res.json(courses);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/trial-courses/:id", async (req, res) => {
  try {
    const course = await trialCourse.findById(req.params.id).lean();
    if (!course) return res.status(404).json({ error: "Cours d'essai introuvable" });
    res.json(course);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ────────────────── LANCEMENT ──────────────────
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Serveur prêt sur le port ${PORT}`));

module.exports = app;