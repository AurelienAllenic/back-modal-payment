require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const Stripe = require("stripe");
const { Resend } = require("resend");
const Traineeship = require('./models/Traineeship')
const Show = require('./models/Show')
const classicCourse = require('./models/ClassicCourse')
const trialCourse = require('./models/TrialCourse')


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
      <p>Catégorie d’âge : ${m.ageGroup || "-"}</p>
      <p>Type : ${m.courseType === "essai" ? "Cours d’essai" : "Cours réguliers"}</p>
    `;
  }
  return "<p>Réservation confirmée.</p>";
};

// ────────────────── ROUTES ──────────────────
app.get("/", (req, res) => res.send("Backend OK"));

// NOUVELLE VERSION → accepte items[] (tableau) OU l'ancien format priceId + quantity
app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { items, customerEmail, metadata = {} } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items manquant" });
    }

    // On ne touche PLUS à bookedPlaces ici → on ne réserve RIEN pour l’instant

    const lineItems = items.map(item => ({
      price: item.price,
      quantity: item.quantity || 1,
    }));

    // On calcule juste le nombre de places demandées (pour le webhook plus tard)
    let requestedPlaces = 0;
    let eventId = null;

    if (metadata.type === "traineeship") {
      requestedPlaces = items.reduce((sum, item) => sum + (item.quantity || 1), 0);
      eventId = `stage-${metadata.eventDate}`; // ex: stage-2025-07-15
    }

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
        eventId: eventId || "",
        requestedPlaces: requestedPlaces.toString(), // ← crucial pour le webhook
        tempReservation: "false", // on marque que c’est pas encore réservé
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("Erreur création session:", error.message);
    res.status(500).json({ error: error.message || "Erreur serveur" });
  }
});

// Les autres routes restent IDENTIQUES
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

// ────────────────── WEBHOOK (inchangé) ──────────────────
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
  const metadata = session.metadata || {};
  const type = metadata.type; // "traineeship", "show", "classic", "trial"
  const quantity = parseInt(metadata.requestedPlaces || "1");
  const eventId = metadata.eventId; // ton ID de stage, show ou cours

  if (type === "traineeship" && eventId) {
    await Traineeship.findByIdAndUpdate(eventId, {
      $inc: { numberOfPlaces: -quantity }
    });
  }

  if (type === "show" && eventId) {
    await Show.findByIdAndUpdate(eventId, {
      $inc: { numberOfPlaces: -quantity }
    });
  }

  if (type === "classic" && eventId) {
    await classicCourse.findByIdAndUpdate(eventId, {
      $inc: { numberOfPlaces: -quantity }
    });
  }

  if (type === "trial" && eventId) {
    await trialCourse.findByIdAndUpdate(eventId, {
      $inc: { numberOfPlaces: -quantity }
    });
  }
}


  
  res.json({ received: true });
});


app.get("/api/traineeships", async (req, res) => {
  try {
    const stages = await Traineeship.find({}).sort({ date: 1 }).lean();
    res.json(stages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Récupérer un stage par ID
app.get("/api/traineeships/:id", async (req, res) => {
  try {
    const stage = await Traineeship.findOne({ id: req.params.id }).lean();
    if (!stage) return res.status(404).json({ error: "Stage introuvable" });
    res.json(stage);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Récupérer tous les shows
app.get("/api/shows", async (req, res) => {
  try {
    const shows = await Show.find({}).sort({ date: 1 }).lean();
    res.json(shows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// Récupérer un show par ID
app.get("/api/shows/:id", async (req, res) => {
  try {
    const show = await Show.findOne({ id: req.params.id }).lean();
    if (!show) return res.status(404).json({ error: "Spectacle introuvable" });
    res.json(show);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});


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