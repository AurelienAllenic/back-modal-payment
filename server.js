require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const Stripe = require("stripe");
const { Resend } = require("resend");

// ────────────────── IMPORTS DES MODÈLES ──────────────────
const Traineeship = require('./models/Traineeship');
const Show = require('./models/Show');
const ClassicCourse = require('./models/ClassicCourse');
const TrialCourse = require('./models/TrialCourse');

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
      enum: ["traineeship", "show", "courses", "trial-course", "classic-course"],
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

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { items, priceId, quantity = 1, customerEmail, metadata = {} } = req.body;

    let lineItems = [];

    if (items && Array.isArray(items) && items.length > 0) {
      lineItems = items.map((item) => ({
        price: item.price,
        quantity: item.quantity,
      }));
    } else if (priceId) {
      lineItems = [{ price: priceId, quantity }];
    } else {
      return res.status(400).json({ error: "priceId ou items manquant" });
    }

    if (lineItems.length === 0) {
      return res.status(400).json({ error: "Aucun article à payer" });
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
        metadata: order.metadata || {},
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

  // ===============================================
  // PAIEMENT RÉUSSI → ON TRAITE LA RÉSERVATION
  // ===============================================
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    const exists = await Order.findOne({ stripeSessionId: session.id });
    if (exists) {
      console.log("Commande déjà traitée →", session.id);
      return res.json({ received: true });
    }

    const metadata = session.metadata || {};
    const type = metadata.type;
    const eventId = metadata.eventId;

    if (!type || !eventId) {
      console.error("eventId ou type manquant dans metadata", metadata);
      return res.json({ received: true });
    }

    let Model;
    if (type === "traineeship") Model = Traineeship;
    else if (type === "show") Model = Show;
    else if (type === "courses") {
      Model = metadata.courseType === "essai" ? TrialCourse : ClassicCourse;
    } else {
      console.error("Type inconnu :", type);
      return res.json({ received: true });
    }

    let placesToBook = 0;
    if (type === "traineeship") {
      placesToBook = parseInt(metadata.nombreParticipants, 10) || 1;
    } else if (type === "show") {
      const adultes = parseInt(metadata.adultes, 10) || 0;
      const enfants = parseInt(metadata.enfants, 10) || 0;
      placesToBook = adultes + enfants;
    } else if (type === "courses") {
      placesToBook = 1;
    }

    if (placesToBook <= 0) {
      console.error("Nombre de places invalide", metadata);
      return res.json({ received: true });
    }

    try {
      const updatedEvent = await Model.findOneAndUpdate(
        {
          _id: eventId,
          numberOfPlaces: { $gte: placesToBook }
        },
        {
          $inc: { numberOfPlaces: -placesToBook }
        },
        { new: true }
      );

      if (!updatedEvent) {
        console.warn(`Plus de places → remboursement session ${session.id}`);

        if (session.payment_intent) {
          await stripe.refunds.create({
            payment_intent: session.payment_intent,
          });
        }

        const clientEmail = metadata.email || session.customer_details?.email;
        // ❌ DÉSACTIVÉ : Envoi d'email de remboursement
        // if (clientEmail?.trim()) {
        //   await resend.emails.send({
        //     from: "Modal Danse <hello@resend.dev>",
        //     to: clientEmail.trim(),
        //     subject: "Réservation impossible – places épuisées",
        //     html: `
        //       <p>Bonjour ${metadata.nom || ""},</p>
        //       <p>Nous sommes vraiment désolés : les dernières places ont été prises juste avant votre paiement.</p>
        //       <p>Vous avez été remboursé(e) intégralement (${(session.amount_total / 100).toFixed(2)} €).</p>
        //       <p>À très vite pour un autre événement !</p>
        //       <p>L'équipe Modal Danse</p>
        //     `,
        //   });
        // }
        return res.json({ received: true });
      }

      const year = new Date().getFullYear();
      const count = await Order.countDocuments({
        createdAt: { $gte: new Date(`${year}-01-01`) },
      });
      const orderNumber = `CMD-${year}-${String(count + 1).padStart(5, "0")}`;

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
        type: metadata.type === "courses" && metadata.courseType === "essai" 
          ? "trial-course" 
          : metadata.type === "courses" 
            ? "classic-course" 
            : metadata.type,
        metadata,
        event: {
          title: updatedEvent.title,
          place: updatedEvent.place,
          date: updatedEvent.date,
          hours: updatedEvent.hours,
        },
      }).save();

      console.log(`RÉSERVATION VALIDÉE → ${orderNumber} | ${placesToBook} place(s) | reste ${updatedEvent.numberOfPlaces}`);

      const confirmationUrl = `${
        process.env.FRONTEND_URL || "https://modal-payment.vercel.app"
      }/success?session_id=${session.id}`;
      const amountFormatted = (order.amountTotal / 100).toFixed(2);

      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #e0e0; border-radius: 12px; background:#fafafa;">
          <h2 style="color:#28a745; text-align:center;">Réservation confirmée !</h2>
          <p>Bonjour ${order.customer.name},</p>
          <p>Nous avons bien reçu votre paiement. Voici votre réservation :</p>
          <div style="background:white; padding:15px; border-radius:8px; margin:20px 0;">
            <p><strong>Numéro :</strong> ${orderNumber}</p>
            <p><strong>Montant :</strong> ${amountFormatted} €</p>
          </div>
          ${getOrderDetailsHtml(order)}
          <div style="text-align:center; margin:30px 0;">
            <a href="${confirmationUrl}" style="background:#28a745; color:white; padding:14px 28px; text-decoration:none; border-radius:8px; font-weight:bold;">Voir ma réservation</a>
          </div>
          <p>À très bientôt !</p>
        </div>
      `;

      // ❌ DÉSACTIVÉ : Envoi d'email de confirmation au client
      // if (order.customer.email) {
      //   await resend.emails.send({
      //     from: "Modal Danse <hello@resend.dev>",
      //     to: order.customer.email.trim(),
      //     subject: `Confirmation – ${orderNumber}`,
      //     html: emailHtml,
      //   });
      // }

      // ❌ DÉSACTIVÉ : Envoi d'email de notification à l'admin
      // if (process.env.ADMIN_EMAIL?.trim()) {
      //   await resend.emails.send({
      //     from: "Modal Danse <hello@resend.dev>",
      //     to: process.env.ADMIN_EMAIL.trim(),
      //     subject: `Nouvelle réservation – ${orderNumber}`,
      //     html: `
      //       <h2>Nouvelle réservation</h2>
      //       <p><strong>${orderNumber}</strong> – ${order.customer.name}</p>
      //       <p>${placesToBook} place(s) → ${updatedEvent.title}</p>
      //       <p>Reste ${updatedEvent.numberOfPlaces} places</p>
      //       ${getOrderDetailsHtml(order)}
      //     `,
      //   });
      // }

    } catch (error) {
      console.error("Erreur critique webhook :", error);
      if (session.payment_intent) {
        try { await stripe.refunds.create({ payment_intent: session.payment_intent }); } catch {}
      }
    }
  }

  res.json({ received: true });
});

// ────────────────── ROUTES TRAINEESHIPS ──────────────────
app.get("/api/traineeships", async (req, res) => {
  try {
    const traineeships = await Traineeship.find({}).sort({ date: 1 }).lean();
    res.json(traineeships);
  } catch (err) {
    console.error("Erreur /api/traineeships:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/traineeships/:id", async (req, res) => {
  try {
    const traineeship = await Traineeship.findById(req.params.id).lean();
    if (!traineeship) return res.status(404).json({ error: "Stage introuvable" });
    res.json(traineeship);
  } catch (err) {
    console.error("Erreur /api/traineeships/:id:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ────────────────── ROUTES SHOWS ──────────────────
app.get("/api/shows", async (req, res) => {
  try {
    const shows = await Show.find({}).sort({ date: 1 }).lean();
    res.json(shows);
  } catch (err) {
    console.error("Erreur /api/shows:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/shows/:id", async (req, res) => {
  try {
    const show = await Show.findById(req.params.id).lean();
    if (!show) return res.status(404).json({ error: "Spectacle introuvable" });
    res.json(show);
  } catch (err) {
    console.error("Erreur /api/shows/:id:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ────────────────── ROUTES CLASSIC COURSES ──────────────────
app.get("/api/classic-courses", async (req, res) => {
  try {
    const courses = await ClassicCourse.find({}).sort({ date: 1 }).lean();
    res.json(courses);
  } catch (err) {
    console.error("Erreur /api/classic-courses:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/classic-courses/:id", async (req, res) => {
  try {
    const course = await ClassicCourse.findById(req.params.id).lean();
    if (!course) return res.status(404).json({ error: "Cours introuvable" });
    res.json(course);
  } catch (err) {
    console.error("Erreur /api/classic-courses/:id:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ────────────────── ROUTES TRIAL COURSES ──────────────────
app.get("/api/trial-courses", async (req, res) => {
  try {
    const courses = await TrialCourse.find({}).sort({ date: 1 }).lean();
    res.json(courses);
  } catch (err) {
    console.error("Erreur /api/trial-courses:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/trial-courses/:id", async (req, res) => {
  try {
    const course = await TrialCourse.findById(req.params.id).lean();
    if (!course) return res.status(404).json({ error: "Cours d'essai introuvable" });
    res.json(course);
  } catch (err) {
    console.error("Erreur /api/trial-courses/:id:", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ────────────────── ROUTES ADMIN CAPACITIES ──────────────────

app.get("/api/admin/events", async (req, res) => {
  try {
    const traineeships = await Traineeship.find({}).sort({ date: 1 }).lean();
    const shows = await Show.find({}).sort({ date: 1 }).lean();
    const classicCourses = await ClassicCourse.find({}).sort({ date: 1 }).lean();
    const trialCourses = await TrialCourse.find({}).sort({ date: 1 }).lean();

    res.json({
      success: true,
      data: {
        traineeships: traineeships.map(t => ({
          _id: t._id,
          type: 'traineeship',
          title: t.title,
          date: t.date,
          place: t.place,
          hours: t.hours,
          numberOfPlaces: t.numberOfPlaces || 0,
        })),
        shows: shows.map(s => ({
          _id: s._id,
          type: 'show',
          title: s.title,
          date: s.date,
          place: s.place,
          hours: s.hours,
          numberOfPlaces: s.numberOfPlaces || 0,
        })),
        classicCourses: classicCourses.map(c => ({
          _id: c._id,
          type: 'classic-course',
          day: c.day,
          time: c.time,
          place: c.place,
          date: c.date,
          numberOfPlaces: c.numberOfPlaces || 0,
        })),
        trialCourses: trialCourses.map(c => ({
          _id: c._id,
          type: 'trial-course',
          time: c.time,
          place: c.place,
          date: c.date,
          numberOfPlaces: c.numberOfPlaces || 0,
        })),
      },
    });
  } catch (err) {
    console.error("Erreur /api/admin/events:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put("/api/admin/events/:type/:id", async (req, res) => {
  try {
    const { type, id } = req.params;
    const { numberOfPlaces } = req.body;

    if (numberOfPlaces === undefined || numberOfPlaces < 0) {
      return res.status(400).json({ error: "numberOfPlaces invalide" });
    }

    let Model;
    if (type === 'traineeship') Model = Traineeship;
    else if (type === 'show') Model = Show;
    else if (type === 'classic-course') Model = ClassicCourse;
    else if (type === 'trial-course') Model = TrialCourse;
    else return res.status(400).json({ error: "Type inconnu" });

    const updated = await Model.findByIdAndUpdate(
      id,
      { numberOfPlaces: Number(numberOfPlaces) },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ error: "Événement introuvable" });
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error("Erreur /api/admin/events/:type/:id:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────── LANCEMENT ──────────────────
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Serveur prêt sur le port ${PORT}`));

module.exports = app;