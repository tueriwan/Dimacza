require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt'); // Seguridad
const jwt = require('jsonwebtoken'); // Login
const nodemailer = require('nodemailer'); // Correo
const PdfPrinter = require('pdfmake'); // PDF
const path = require('path');
const fs = require('fs'); // Sistema de archivos
const multer = require('multer'); // Subida de archivos
const { GoogleGenerativeAI } = require("@google/generative-ai");

// CONFIGURACIÓN GEMINI

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
// --- NUEVO: Servir los archivos del Frontend (carpeta public) ---
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = 'secreto_super_seguro_para_la_u'; 

// =======================================================
// 1. CONFIGURACIÓN DE SUBIDA DE ARCHIVOS (MULTER)
// =======================================================
// Crear carpeta 'uploads' si no existe
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Configurar dónde se guardan los archivos
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        // Nombre único: fecha-nombreOriginal
        cb(null, Date.now() + '-' + file.originalname)
    }
});
const upload = multer({ storage: storage });

// Hacer pública la carpeta para poder ver los archivos desde el frontend
app.use('/uploads', express.static(uploadDir));

// =======================================================
// 2. CONFIGURACIÓN DE PDF Y CORREO
// =======================================================
const transporter = nodemailer.createTransport({
    service: 'gmail', 
    auth: {
        user: process.env.EMAIL_USER || 'tu_correo@gmail.com', 
        pass: process.env.EMAIL_PASS || 'tu_contraseña'
    }
});

// =======================================================
// 3. INICIALIZACIÓN DE LA BASE DE DATOS
// =======================================================
const initDB = async () => {
    try {
        // Usuarios
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(100) UNIQUE,
                password VARCHAR(255),
                role VARCHAR(50) DEFAULT 'vendedor'
            );
        `);

        // Empresas
        await pool.query(`
            CREATE TABLE IF NOT EXISTS companies (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255),
                industry VARCHAR(255),
                city VARCHAR(255),
                address VARCHAR(255) DEFAULT '',
                status VARCHAR(50) DEFAULT 'Prospecto',
                type VARCHAR(50) DEFAULT 'Cliente',
                rut VARCHAR(50),
                giro VARCHAR(255)
            );
        `);

        // Contactos
        await pool.query(`
            CREATE TABLE IF NOT EXISTS contacts (
                id SERIAL PRIMARY KEY,
                company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
                name VARCHAR(100),
                phone VARCHAR(50),
                role VARCHAR(100),
                next_call DATE,
                email VARCHAR(100)
            );
        `);

        // Productos
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id SERIAL PRIMARY KEY,
                sku VARCHAR(100),
                name VARCHAR(255),
                price DECIMAL(12,2),
                description TEXT
            );
        `);

        // Documentos
        await pool.query(`
            CREATE TABLE IF NOT EXISTS documents (
                id SERIAL PRIMARY KEY,
                type VARCHAR(20),       
                folio INTEGER,          
                company_id INTEGER REFERENCES companies(id),
                date DATE DEFAULT CURRENT_DATE,
                expiration_date DATE,
                status VARCHAR(50) DEFAULT 'Emitida',
                neto DECIMAL(12,2) DEFAULT 0,
                tax DECIMAL(12,2) DEFAULT 0,
                total DECIMAL(12,2) DEFAULT 0,
                notes TEXT,
                payment_terms VARCHAR(255),
                delivery_time VARCHAR(255),
                warranty VARCHAR(255),
                reference VARCHAR(255),  
                parent_id INTEGER,
                driver VARCHAR(255),
                plate VARCHAR(255),
                dispatch_type VARCHAR(255),
                file_url VARCHAR(500)
            );
        `);

        // Items de Documentos
        await pool.query(`
            CREATE TABLE IF NOT EXISTS document_items (
                id SERIAL PRIMARY KEY, 
                document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE, 
                product_id INTEGER, 
                name VARCHAR(255), 
                description TEXT,
                quantity INTEGER, 
                price DECIMAL(12,2), 
                total DECIMAL(12,2)
            );
        `);

        // --- PARCHES Y DATOS POR DEFECTO ---
        
        // 1. Crear Admin si no existe
        const userCheck = await pool.query("SELECT * FROM users WHERE email = 'admin@erp.com'");
        if (userCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('123456', 10);
            await pool.query("INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4)", ['Administrador', 'admin@erp.com', hashedPassword, 'admin']);
            console.log("👤 Usuario Admin creado.");
        }

        // 2. Parches de columnas (Evita errores si la tabla ya existía)
        await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'Cliente'");
        await pool.query("ALTER TABLE document_items ADD COLUMN IF NOT EXISTS description TEXT");
        await pool.query("ALTER TABLE documents ADD COLUMN IF NOT EXISTS folio INTEGER");
        await pool.query("ALTER TABLE documents ADD COLUMN IF NOT EXISTS driver VARCHAR(255)");
        await pool.query("ALTER TABLE documents ADD COLUMN IF NOT EXISTS plate VARCHAR(255)");
        await pool.query("ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_url VARCHAR(500)");
        
        // --- PARCHES NUEVOS (RUT, GIRO, EMAIL) ---
        await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS rut VARCHAR(50)");
        await pool.query("ALTER TABLE companies ADD COLUMN IF NOT EXISTS giro VARCHAR(255)");
        await pool.query("ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email VARCHAR(100)");

        console.log("✅ BASE DE DATOS SINCRONIZADA Y LISTA.");
    } catch (err) {
        console.error("Error iniciando DB:", err);
    }
};

initDB();

// =======================================================
// 4. RUTAS API (ENDPOINTS)
// =======================================================

// --- AUTENTICACIÓN (LOGIN) ---
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];
        if (!user) return res.status(400).json({ error: "Usuario no encontrado" });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: "Contraseña incorrecta" });

        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
        res.json({ message: "Login exitoso", token, user: { name: user.name, role: user.role } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SUBIDA DE ARCHIVOS ---
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No se subió archivo" });
    res.json({ url: `/uploads/${req.file.filename}` });
});

// --- GESTIÓN DE USUARIOS ---
app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, email, role FROM users ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/users', async (req, res) => {
    const { name, email, password, role } = req.body;
    if(!name || !email || !password) return res.status(400).json({ error: "Faltan datos" });
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
            [name, email, hashedPassword, role || 'vendedor']
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: "Error al crear (posible email duplicado)" }); }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.json({ message: "Usuario eliminado" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- EMPRESAS (MODIFICADO PARA RUT Y GIRO) ---
app.get('/api/companies', async (req, res) => {
    try {
        const { type } = req.query; 
        let query = 'SELECT * FROM companies';
        let params = [];
        if (type) {
            query += ' WHERE type = $1';
            params.push(type);
        }
        query += ' ORDER BY id DESC';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// --- NUEVO: IMPORTACIÓN MASIVA DE EMPRESAS ---
app.post('/api/companies/import', async (req, res) => {
  const companies = req.body; // Recibimos la lista del Excel

  if (!Array.isArray(companies) || companies.length === 0) {
    return res.status(400).json({ error: 'No hay datos para importar' });
  }

  try {
    // Recorremos la lista y guardamos uno por uno
    for (const c of companies) {
      // OJO: Asumimos que son 'Cliente' por defecto si no viene el tipo
      await pool.query(
        `INSERT INTO companies (name, rut, giro, industry, city, type, address, status) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          c.name, 
          c.rut, 
          c.giro, 
          c.industry, 
          c.city, 
          'Cliente',      // Tipo por defecto
          'Dirección pendiente', // Dirección por defecto
          'Activo'        // Estado por defecto
        ]
      );
    }
    res.json({ message: 'Importación exitosa' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar en la base de datos' });
  }
});
app.post('/api/companies', async (req, res) => {
    const { name, industry, city, status, address, type, rut, giro } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO companies (name, industry, city, status, address, type, rut, giro) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [name, industry, city, status || 'Prospecto', address || '', type || 'Cliente', rut || '', giro || '']
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/companies/:id', async (req, res) => {
    const { name, industry, city, address, type, rut, giro } = req.body;
    try {
        const result = await pool.query(
            'UPDATE companies SET name = $1, industry = $2, city = $3, address = $4, type = $5, rut = $6, giro = $7 WHERE id = $8 RETURNING *',
            [name, industry, city, address, type, rut, giro, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/companies/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM companies WHERE id = $1', [req.params.id]);
        res.json({ message: "Eliminado correctamente" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/companies/import', async (req, res) => {
    const companies = req.body;
    if (!Array.isArray(companies)) return res.status(400).json({ error: "Formato inválido" });
    try {
        for (const c of companies) {
            await pool.query(
                'INSERT INTO companies (name, industry, city, status, address, type) VALUES ($1, $2, $3, $4, $5, $6)',
                [c['Nombre'] || 'Sin Nombre', c['Rubro'] || '', c['Ciudad'] || '', 'Prospecto', c['Dirección'] || '', 'Cliente']
            );
        }
        res.json({ message: "Importación exitosa" });
    } catch (err) { res.status(500).json({ error: "Error importando" }); }
});

// --- CONTACTOS (MODIFICADO PARA EMAIL) ---
app.get('/api/contacts/:companyId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM contacts WHERE company_id = $1 ORDER BY id DESC', [req.params.companyId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts', async (req, res) => {
    const { company_id, name, phone, email, role, next_call } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO contacts (company_id, name, phone, email, role, next_call) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [company_id, name, phone, email || '', role, next_call || null]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/contacts/:id', async (req, res) => {
    const { name, phone, email, role, next_call } = req.body;
    try {
        if (name) {
            await pool.query('UPDATE contacts SET name = $1, phone = $2, email = $3, role = $4 WHERE id = $5', [name, phone, email, role, req.params.id]);
        }
        if (next_call !== undefined) {
            await pool.query('UPDATE contacts SET next_call = $1 WHERE id = $2', [next_call, req.params.id]);
        }
        res.json({ message: "Contacto actualizado" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/contacts/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
        res.json({ message: "Contacto eliminado" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- PRODUCTOS ---
app.get('/api/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/products', async (req, res) => {
    const { sku, name, price, description } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO products (sku, name, price, description) VALUES ($1, $2, $3, $4) RETURNING *',
            [sku, name, price || 0, description]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/products/:id', async (req, res) => {
    const { sku, name, price, description } = req.body;
    try {
        const result = await pool.query(
            'UPDATE products SET sku = $1, name = $2, price = $3, description = $4 WHERE id = $5 RETURNING *',
            [sku, name, price, description, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
        res.json({ message: "Producto eliminado" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- DOCUMENTOS (MODIFICADO: JOIN PARA TRAER RUT Y GIRO) ---
app.post('/api/documents', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { type, company_id, date, expiration_date, items, notes, payment_terms, delivery_time, warranty, reference, parent_id, status, driver, plate, dispatch_type, file_url, total } = req.body;
        
        // Determinar Folio
        let nextFolio = req.body.folio; // Si viene manual (para archivos subidos)
        if (!nextFolio) {
            // Si es automático (para ventas del sistema)
            const folioRes = await client.query('SELECT COALESCE(MAX(folio), 0) + 1 as next_folio FROM documents WHERE type = $1', [type]);
            nextFolio = folioRes.rows[0].next_folio;
        }

        // Determinar Totales
        let finalTotal = total || 0;
        let neto = 0, tax = 0;
        if(items && items.length > 0) {
            items.forEach(item => { neto += item.quantity * item.price; });
            tax = Math.round(neto * 0.19);
            finalTotal = neto + tax;
        }

        const docRes = await client.query(
            `INSERT INTO documents (type, folio, company_id, date, expiration_date, status, neto, tax, total, notes, payment_terms, delivery_time, warranty, reference, parent_id, driver, plate, dispatch_type, file_url) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
            [type, nextFolio, company_id, date, expiration_date || null, status || 'Emitida', neto, tax, finalTotal, notes, payment_terms, delivery_time, warranty, reference || '', parent_id || null, driver || '', plate || '', dispatch_type || '', file_url || '']
        );
        const docId = docRes.rows[0].id;

        // Guardar items (si existen)
        if(items && items.length > 0) {
            for (const item of items) {
                await client.query(
                    `INSERT INTO document_items (document_id, product_id, name, description, quantity, price, total) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [docId, item.product_id, item.name, item.description || '', item.quantity, item.price, (item.quantity * item.price)]
                );
            }
        }
        await client.query('COMMIT');
        res.json({ message: "Documento creado exitosamente", document: docRes.rows[0] });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Error creando documento:", e);
        res.status(500).json({ error: e.message });
    } finally { client.release(); }
});

app.get('/api/documents', async (req, res) => {
    try {
        const { type, search } = req.query;
        // CONSULTA ACTUALIZADA PARA TRAER DATOS DE LA EMPRESA (RUT, GIRO)
        let query = `SELECT d.*, c.name as company_name, c.rut as company_rut, c.giro as company_giro, c.address as company_address, c.city as company_city 
                     FROM documents d JOIN companies c ON d.company_id = c.id`;
        let params = [];
        let conditions = [];

        if(type) { conditions.push(`d.type = $${params.length + 1}`); params.push(type); }
        if(search) {
            conditions.push(`(c.name ILIKE $${params.length + 1} OR CAST(d.folio AS TEXT) ILIKE $${params.length + 1} OR d.reference ILIKE $${params.length + 1})`);
            params.push(`%${search}%`);
        }
        if(conditions.length > 0) query += ` WHERE ` + conditions.join(' AND ');
        
        query += ` ORDER BY d.id DESC`;
        const result = await pool.query(query, params);
        const docs = result.rows;

        for(let doc of docs){
            const itemsRes = await pool.query('SELECT * FROM document_items WHERE document_id = $1', [doc.id]);
            doc.items = itemsRes.rows;
        }
        res.json(docs);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/documents/:id/status', async (req, res) => {
    try {
        await pool.query('UPDATE documents SET status = $1 WHERE id = $2', [req.body.status, req.params.id]);
        res.json({ message: "Estado actualizado" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// --- ELIMINAR DOCUMENTO (Faltaba esto) ---
app.delete('/api/documents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Borramos el documento de la base de datos
    await pool.query('DELETE FROM documents WHERE id = $1', [id]);
    res.json({ message: 'Documento eliminado correctamente' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al eliminar documento' });
  }
});
// Placeholder para email si en el futuro lo usas
app.post('/api/send-email-oc/:id', async (req, res) => {
    res.json({ message: "Usa el cliente nativo del frontend" });
});
// --- NUEVO: Cualquier ruta que no sea API, manda al index.html (React) ---
// Usamos /.*/ en lugar de '*' para que funcione en Express 5
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// --- RUTA CHAT INTELIGENTE (GEMINI) ---
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    // 1. Configuramos el modelo
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    // 2. Iniciamos el chat con instrucciones
    const chat = model.startChat({
      history: [
        {
          role: "user",
          parts: [{ text: "Eres el asistente experto del ERP Dimacza. Responde breve y cordial." }],
        },
        {
          role: "model",
          parts: [{ text: "Entendido. Soy el asistente virtual de Dimacza. ¿En qué puedo ayudarte?" }],
        },
      ],
    });

    // 3. Enviamos el mensaje
    const result = await chat.sendMessage(message);
    const response = await result.response;
    const text = response.text();
    
    res.json({ reply: text });
    
  } catch (err) {
    console.error("Error IA:", err);
    res.status(500).json({ error: "La IA está durmiendo zzz" });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor CRM/ERP corriendo en http://localhost:${PORT}`);
});