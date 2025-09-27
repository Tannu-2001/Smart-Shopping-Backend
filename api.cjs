const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname,"public")));


const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://tannukumari749_db_user:Gunnu2020@ishop-cluster.zi1yofm.mongodb.net/?retryWrites=true&w=majority&appName=ishop-cluster";
const DB_NAME = process.env.DB_NAME || "ishopdb";

const client = new MongoClient(MONGO_URI, { useUnifiedTopology: true });

async function getDb() {
  if (!client.topology || !client.topology.isConnected?.()) {
    await client.connect();
    console.log('Mongo client connected');
  }
  console.log('db name used:',DB_NAME)
  return client.db(DB_NAME);
}

/* ----------------- API ROUTES ----------------- */

app.get("/getproducts", async (req, res) => {
  try {
    const db = await getDb();
    const documents = await db.collection("tblproducts").find({}).toArray();
    res.json(documents);
  } catch (err) {
    console.error("GET /getproducts error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// single product by numeric id or by _id
app.get("/products/:id", async (req, res) => {
  try {
    const rawId = req.params.id;
    const db = await getDb();

    // try numeric match first
    if (!isNaN(rawId)) {
      const idNum = Number(rawId);
      const doc = await db.collection("tblproducts").findOne({ id: idNum });
      if (doc) return res.json(doc);
    }

    // try _id (ObjectId) if looks like 24-hex
    if (/^[0-9a-fA-F]{24}$/.test(rawId)) {
      const doc = await db.collection("tblproducts").findOne({ _id: new ObjectId(rawId) });
      if (doc) return res.json(doc);
    }

    // fallback search by string id field or product_id
    const doc = await db
      .collection("tblproducts")
      .findOne({ $or: [{ product_id: rawId }, { id: rawId }, { title: rawId }] });

    if (!doc) return res.status(404).json({ error: "Product not found" });
    return res.json(doc);
  } catch (err) {
    console.error("GET /products/:id error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/categories", async (req, res) => {
  try {
    const db = await getDb();
    const documents = await db.collection("tblcategories").find({}).toArray();
    res.json(documents);
  } catch (err) {
    console.error("GET /categories error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/categories/:category", async (req, res) => {
  try {
    const cat = req.params.category;
    const db = await getDb();
    const documents = await db.collection("tblproducts").find({ category: cat }).toArray();
    res.json(documents);
  } catch (err) {
    console.error("GET /categories/:category error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/getcustomers", async (req, res) => {
  try {
    const db = await getDb();
    const documents = await db.collection("tblcustomers").find({}).toArray();
    res.json(documents);
  } catch (err) {
    console.error("GET /getcustomers error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/customerregister", async (req, res) => {
  try {
    const data = {
      UserId: req.body.UserId,
      FirstName: req.body.FirstName,
      LastName: req.body.LastName,
      DateOfBirth: req.body.DateOfBirth ? new Date(req.body.DateOfBirth) : null,
      Email: req.body.Email,
      Gender: req.body.Gender,
      Address: req.body.Address,
      PostalCode: req.body.PostalCode,
      State: req.body.State,
      Country: req.body.Country,
      Mobile: req.body.Mobile,
      Password: req.body.Password,
    };
    const db = await getDb();
    await db.collection("tblcustomers").insertOne(data);
    res.json({ message: "Customer registered" });
  } catch (err) {
    console.error("POST /customerregister error:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

/* ----------------- ORDER CREATION ----------------- */

app.post("/createorder", async (req, res) => {
  try {
    const db = await getDb(); // IMPORTANT: ensure db is set

    const payload = req.body;
    console.log("CreateOrder payload:", JSON.stringify(payload, null, 2));

    // Validate basic payload shape
    if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
      return res.status(400).json({ success: false, message: "Invalid payload: items required" });
    }

    // Build queries to find products in DB
    const items = payload.items;

    const numericIds = [];
    const objectIds = [];
    const stringIds = [];

    items.forEach(it => {
      const pid = it.productId;
      if (typeof pid === "string" && /^[0-9a-fA-F]{24}$/.test(pid)) {
        objectIds.push(new ObjectId(pid));
      } else if (!isNaN(Number(pid))) {
        numericIds.push(Number(pid));
      } else {
        stringIds.push(String(pid));
      }
    });

    const queryOr = [];
    if (objectIds.length) queryOr.push({ _id: { $in: objectIds } });
    if (numericIds.length) queryOr.push({ id: { $in: numericIds } });
    if (stringIds.length) queryOr.push({ id: { $in: stringIds } }, { product_id: { $in: stringIds } });

    let dbProducts = [];
    if (queryOr.length) {
      dbProducts = await db.collection("tblproducts").find({ $or: queryOr }).toArray();
    } else {
      dbProducts = await db.collection("tblproducts").find({}).toArray();
    }

    // index map
    const productMap = {};
    dbProducts.forEach(p => {
      if (p._id) productMap[String(p._id)] = p;
      if (p.id !== undefined) productMap[String(p.id)] = p;
      if (p.product_id !== undefined) productMap[String(p.product_id)] = p;
    });

    // validate and compute totals
    let computedSubtotal = 0;
    const validatedItems = [];

    for (const it of items) {
      const key = String(it.productId);
      const prod = productMap[key];
      if (!prod) {
        console.error("Product not found for item:", it);
        return res.status(400).json({ success: false, message: `Product not found: ${it.productId}` });
      }
      const unitPrice = Number(prod.price || 0);
      const qty = Number(it.qty || 1);
      if (isNaN(unitPrice)) {
        console.error("Invalid price in DB for product", prod);
        return res.status(500).json({ success: false, message: "Server product price error" });
      }
      const lineTotal = unitPrice * qty;
      computedSubtotal += lineTotal;

      validatedItems.push({
        productId: String(prod._id || prod.id),
        title: prod.title || prod.name || "",
        unitPrice,
        qty,
        lineTotal,
      });
    }

    // optional check: client subtotal should be similar
    if (payload.subtotal !== undefined) {
      const diff = Math.abs(Number(payload.subtotal) - computedSubtotal);
      if (diff > 0.5) {
        console.warn("Subtotal mismatch: client sent", payload.subtotal, "computed", computedSubtotal);
        return res.status(400).json({ success: false, message: "Subtotal mismatch" });
      }
    }

    const shipping = Number(payload.shipping || 0);
    const tax = Number(payload.tax || 0);
    const total = Number(payload.total || computedSubtotal + shipping + tax);

    const orderDoc = {
      userId: payload.userId || null,
      items: validatedItems,
      subtotal: computedSubtotal,
      shipping,
      tax,
      total,
      createdAt: new Date(),
      status: "created",
    };

    const insertRes = await db.collection("tblorders").insertOne(orderDoc);
    console.log("Order inserted:", insertRes.insertedId);

    return res.json({ success: true, orderId: String(insertRes.insertedId), message: "Order created" });
  } catch (err) {
    console.error("Create order failed:", err);
    return res.status(500).json({ success: false, message: err.message || "Unknown server error" });
  }
});

/* ------------- static frontend ------------- */

const frontendPath = path.join(__dirname, "..", "Shopping-Frontend", "ishop-project");
app.use(express.static(frontendPath));

// fallback: if not API, send index.html
app.use((req, res) => {
  const isApi =
    req.path.startsWith("/products") ||
    req.path.startsWith("/get") ||
    req.path.startsWith("/categories") ||
    req.path.startsWith("/admin") ||
    req.path.startsWith("/customer") ||
    req.path.startsWith("/createorder");

  if (isApi) {
    return res.status(404).json({ error: "API endpoint not found" });
  }
  try {
    return res.sendFile(path.join(frontendPath, "index.html"));
  } catch (err) {
    return res.send("API is running (frontend not found).");
  }
});

app.post("/addtocart", async (req, res) => {
  try {
    const db = await getDb();
    const { userId, productId, qty } = req.body;

    if (!userId || !productId) {
      return res.status(400).json({ success: false, message: "userId and productId required" });
    }

    // check if already exists
    const existing = await db.collection("tblshoppingcart").findOne({ userId, productId });
    if (existing) {
      // update qty
      await db.collection("tblshoppingcart").updateOne(
        { userId, productId },
        { $set: { qty: existing.qty + (qty || 1) } }
      );
    } else {
      await db.collection("tblshoppingcart").insertOne({
        userId,
        productId,
        qty: qty || 1,
        addedAt: new Date()
      });
    }

    res.json({ success: true, message: "Cart updated" });
  } catch (err) {
    console.error("POST /addtocart error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get current user cart
app.get("/getcart/:userId", async (req, res) => {
  try {
    const db = await getDb();
    const userId = req.params.userId;

    const cart = await db.collection("tblshoppingcart").find({ userId }).toArray();
    res.json(cart);
  } catch (err) {
    console.error("GET /getcart error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ----------------- START ----------------- */
const PORT = process.env.PORT || 4400;
app.listen(PORT, () => console.log(`API Starter http://127.0.0.1:${PORT}`));

