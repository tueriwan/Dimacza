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

// --- NUEVO: IMPORTACIÓN MASIVA DE EMPRESAS ---
app.post('/api/companies/import', async (req, res) => {
    const companies = req.body;
    if (!Array.isArray(companies)) return res.status(400).json({ error: "Formato inválido" });
    try {
        for (const c of companies) {
            // OJO: Asumimos que son 'Cliente' por defecto si no viene el tipo
            await pool.query(
                `INSERT INTO companies (name, rut, giro, industry, city, type, address, status) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [c.name, c.rut, c.giro, c.industry, c.city, 'Cliente', 'Dirección pendiente', 'Activo']
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

// --- DOCUMENTOS (MODIFICADO: JOIN PARA TRAER RUT Y GIRO Y FOLIO DESDE 6060) ---
app.post('/api/documents', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { type, company_id, date, expiration_date, items, notes, payment_terms, delivery_time, warranty, reference, parent_id, status, driver, plate, dispatch_type, file_url, total } = req.body;
        
        // Determinar Folio
        let nextFolio = req.body.folio; // Si viene manual (para archivos subidos)
        if (!nextFolio) {
            // Si es automático (para ventas del sistema)
            // MODIFICACIÓN AQUI: Usamos GREATEST para asegurar que comience en 6060 si es menor
            const folioRes = await client.query('SELECT GREATEST(COALESCE(MAX(folio), 0) + 1, 6060) as next_folio FROM documents WHERE type = $1', [type]);
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

// --- ELIMINAR DOCUMENTO ---
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

// Placeholder para email
app.post('/api/send-email-oc/:id', async (req, res) => {
    res.json({ message: "Usa el cliente nativo del frontend" });
});


// =======================================================
// RUTA VISUALIZACIÓN FORMATO SII 
// =======================================================
app.get('/api/documents/:id/ver', async (req, res) => {
    try {
        const { id } = req.params;
        
        // 1. Buscamos datos (Igual que antes)
        const docRes = await pool.query(`
            SELECT d.*, c.name as company_name, c.rut as company_rut, c.giro as company_giro, c.address as company_address, c.city as company_city 
            FROM documents d 
            JOIN companies c ON d.company_id = c.id 
            WHERE d.id = $1
        `, [id]);
        
        if (docRes.rows.length === 0) return res.status(404).send('Documento no encontrado');
        const doc = docRes.rows[0];

        const itemsRes = await pool.query('SELECT * FROM document_items WHERE document_id = $1', [id]);
        const items = itemsRes.rows;

        // 2. Formateadores de moneda (Pesos Chilenos)
        const clp = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' });

        // 3. HTML CON DISEÑO SII (Cuadro Rojo)
        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>DTE ${doc.folio}</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 40px; color: #000; max-width: 850px; margin: 0 auto; font-size: 14px; }
                
                /* CABECERA SII */
                .header-sii { display: flex; justify-content: space-between; margin-bottom: 30px; }
                .company-data { width: 60%; }
                .company-data h1 { margin: 0; font-size: 28px; color: #000; text-transform: uppercase; }
                .company-data p { margin: 2px 0; font-weight: bold; color: #444; }
                
                /* EL FAMOSO CUADRO ROJO */
                .rut-box {
                    width: 280px;
                    border: 4px solid #FF0000;
                    text-align: center;
                    color: #FF0000;
                    padding: 15px 5px;
                    font-weight: bold;
                }
                .rut-box .rut { font-size: 22px; margin-bottom: 5px; display: block; }
                .rut-box .tipo-doc { font-size: 18px; display: block; margin: 10px 0; color: #FF0000; }
                .rut-box .folio { font-size: 22px; display: block; }

                /* DATOS CLIENTE */
                .client-box { border: 1px solid #000; padding: 10px; margin-bottom: 20px; display: flex; flex-wrap: wrap; }
                .client-row { width: 100%; display: flex; margin-bottom: 5px; }
                .label { width: 100px; font-weight: bold; }
                .value { flex: 1; }

                /* TABLA ITEMS */
                table { width: 100%; border-collapse: collapse; margin-bottom: 20px; border: 1px solid #000; }
                th { border: 1px solid #000; padding: 8px; text-align: center; font-size: 12px; background: #eee; }
                td { border: 1px solid #000; padding: 8px; font-size: 12px; }
                
                /* TOTALES */
                .footer-section { display: flex; justify-content: space-between; align-items: flex-start; }
                .timbre-electronico { width: 300px; height: 120px; border: 1px solid #ccc; display: flex; align-items: center; justify-content: center; color: #ccc; font-size: 10px; text-align: center; }
                
                .totals-box { width: 250px; border: 1px solid #000; }
                .total-row { display: flex; justify-content: space-between; padding: 5px 10px; }
                .total-row.final { background: #ddd; font-weight: bold; }

                .btn-print { position: fixed; bottom: 20px; right: 20px; background: #333; color: white; border: none; padding: 15px 30px; cursor: pointer; border-radius: 50px; font-size: 16px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); }
                @media print { .btn-print { display: none; } }
            </style>
        </head>
        <body>
            <div class="header-sii">
                <div class="company-data">
                    <h1>DIMACZA ERP</h1>
                    <p>GIRO: VENTA DE ARTICULOS DE COMPUTACIÓN</p>
                    <p>DIRECCIÓN: AV. SIEMPRE VIVA 742</p>
                    <p>DIRECCIÓN: AV. SIEMPRE VIVA 742</p>
                    <p>CIUDAD: SANTIAGO</p>
                    <br>
                    <p>Fecha Emisión: ${new Date(doc.date).toLocaleDateString('es-CL')}</p>
                </div>
                
                <div class="rut-box">
                    <span class="rut">R.U.T.: 76.123.456-7</span>
                    <span class="tipo-doc">FACTURA ELECTRÓNICA</span>
                    <span class="folio">Nº ${doc.folio}</span>
                </div>
            </div>

            <div class="client-box">
                <div class="client-row">
                    <div class="label">Señor(es):</div>
                    <div class="value">${doc.company_name}</div>
                </div>
                <div class="client-row">
                    <div class="label">R.U.T.:</div>
                    <div class="value">${doc.company_rut || 'Sin RUT'}</div>
                </div>
                <div class="client-row">
                    <div class="label">Giro:</div>
                    <div class="value">${doc.company_giro || 'Comercial'}</div>
                </div>
                <div class="client-row">
                    <div class="label">Dirección:</div>
                    <div class="value">${doc.company_address || 'Sin dirección'}, ${doc.company_city || ''}</div>
                </div>
            </div>

            <table>
                <thead>
                    <tr>
                        <th>Descripción</th>
                        <th width="50">Cant.</th>
                        <th width="100">Precio Unit.</th>
                        <th width="100">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.map(item => `
                    <tr>
                        <td>${item.name}</td>
                        <td style="text-align: center">${item.quantity}</td>
                        <td style="text-align: right">${clp.format(item.price)}</td>
                        <td style="text-align: right">${clp.format(item.quantity * item.price)}</td>
                    </tr>
                    `).join('')}
                </tbody>
            </table>

            <div class="footer-section">
                <div class="timbre-area">
                   <div class="timbre-electronico">
                        Timbre Electrónico SII<br>
                        Res. 99 de 2014 Verifique documento: www.sii.cl
                   </div>
                </div>

                <div class="totals-box">
                    <div class="total-row">
                        <span>Monto Neto:</span>
                        <span>${clp.format(doc.neto)}</span>
                    </div>
                    <div class="total-row">
                        <span>I.V.A. (19%):</span>
                        <span>${clp.format(doc.tax)}</span>
                    </div>
                    <div class="total-row final">
                        <span>TOTAL:</span>
                        <span>${clp.format(doc.total)}</span>
                    </div>
                </div>
            </div>

            <button onclick="window.print()" class="btn-print">🖨️ IMPRIMIR</button>
        </body>
        </html>
        `;

        res.send(html);

    } catch (err) {
        console.error(err);
        res.status(500).send("Error generando documento SII");
    }
});

// =======================================================
// 5. CHAT INTELIGENTE CON BÚSQUEDA EN BASE DE DATOS
// =======================================================

// 🛠️ DEFINIMOS LA HERRAMIENTA DE BÚSQUEDA
const herramientasERP = [
  {
    functionDeclarations: [
      {
        name: "buscar_documentos_erp",
        description: "Busca facturas, cotizaciones, notas de venta o documentos de un cliente en la base de datos. Permite filtrar por tipo de documento.",
        parameters: {
          type: "OBJECT",
          properties: {
            nombre_cliente: { type: "STRING", description: "Nombre de la empresa o cliente a buscar (ej: 'Sefutec', 'Juan Perez')" },
            tipo_doc: { type: "STRING", description: "Tipo de documento opcional (ej: FAC para factura, COT para cotización, NV para nota venta)" }
          },
          required: ["nombre_cliente"],
        },
      },
    ],
  },
];

app.post('/api/chat', async (req, res) => {
    try {
        // Obtenemos los datos del frontend
        const { message, usuario, rol } = req.body;
        console.log(`💬 Chat iniciado por: ${usuario} (${rol})`);

        // --- 🛡️ SEGURIDAD MEJORADA: Filtro de permisos ---
        // Convertimos el rol a mayúsculas para evitar errores (admin vs ADMIN)
        const rolNormalizado = rol ? rol.toUpperCase() : "";
        const esUsuarioAutorizado = (rolNormalizado === "ADMIN" || rolNormalizado === "VENDEDOR");

        // --- 🧠 CONFIGURACIÓN DEL MODELO GEMINI 2.5 FLASH (CUPOS ALTOS) ---
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash", // Usamos el 1.5 para evitar Error 429
            tools: herramientasERP,
            // 👇 DESACTIVAMOS FILTROS PARA EVITAR ERROR 500
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            ]
        });

        // Iniciamos el chat
        const chat = model.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: `Eres el asistente experto del ERP Dimacza. 
                                     Usuario actual: ${usuario}. 
                                     Rol: ${rol}.
                                     Responde de forma útil y profesional.` }],
                },
                {
                    role: "model",
                    parts: [{ text: "Entendido. Estoy listo para ayudar con información del ERP y búsqueda de documentos si tienes los permisos necesarios." }],
                }
            ],
        });

        // 1. Enviamos el mensaje del usuario a la IA
        const result = await chat.sendMessage(message);
        const response = result.response;
        const functionCalls = response.functionCalls();

        // --- 🤖 VERIFICAMOS SI LA IA DECIDIÓ BUSCAR EN LA BASE DE DATOS ---
        if (functionCalls && functionCalls.length > 0) {
            const llamada = functionCalls[0];
            const args = llamada.args;
            
            console.log("🔍 IA solicitando búsqueda en DB:", args);

            // A. Verificación de Seguridad
            if (!esUsuarioAutorizado) {
                return res.json({ 
                    reply: `🚫 Lo siento ${usuario}, he detectado que buscas documentos internos, pero tu rol actual (${rol}) no tiene permisos para acceder a la base de datos de archivos.` 
                });
            }

            // B. Construcción de la Consulta SQL (JOIN entre documents y companies)
            // Buscamos documentos donde el nombre de la compañía coincida con lo que pide el usuario
            let sqlQuery = `
                SELECT 
                    d.id, 
                    d.type, 
                    d.folio, 
                    d.date, 
                    d.total,
                    d.file_url,
                    c.name as nombre_empresa
                FROM documents d
                JOIN companies c ON d.company_id = c.id
                WHERE c.name ILIKE $1
            `;
            
            const values = [`%${args.nombre_cliente}%`];

            // Si la IA detectó un tipo de documento específico, lo filtramos
            if (args.tipo_doc) {
                let tipoCodigo = args.tipo_doc.toUpperCase();
                // Normalizamos lo que dice la IA a tus códigos de DB (FAC, COT, NV, etc)
                if (tipoCodigo.includes("FACTURA")) tipoCodigo = "FAC";
                if (tipoCodigo.includes("COTIZA")) tipoCodigo = "COT";
                if (tipoCodigo.includes("VENTA")) tipoCodigo = "NV";
                if (tipoCodigo.includes("GUIA")) tipoCodigo = "GD";
                
                sqlQuery += ` AND d.type ILIKE $2`;
                values.push(`%${tipoCodigo}%`);
            }

            // Ordenamos por fecha descendente y limitamos a 5 resultados
            sqlQuery += ` ORDER BY d.date DESC LIMIT 5`;

            try {
                // Ejecutamos la consulta en Postgres
                const dbResult = await pool.query(sqlQuery, values);

                if (dbResult.rows.length > 0) {
                    // C. Formateamos los resultados para que la IA los entienda
                    const docsEncontrados = dbResult.rows.map(doc => ({
                        tipo: doc.type,
                        folio: doc.folio,
                        cliente: doc.nombre_empresa,
                        total: doc.total, // Opcional: mostrar monto
                        fecha: doc.date.toISOString().split('T')[0], // Solo la fecha YYYY-MM-DD
                        
                        // ✅ GENERACIÓN DEL LINK NUEVO (Apunta a /ver)
                        link_visualizacion: doc.file_url 
                            ? `https://dimacza.onrender.com${doc.file_url}` 
                            : `https://dimacza.onrender.com/api/documents/${doc.id}/ver` 
                    }));

                    // D. Devolvemos los datos a la IA
                    const functionResponse = [{
                        functionResponse: {
                            name: "buscar_documentos_erp",
                            response: { status: "exito", documentos: docsEncontrados }
                        }
                    }];
                    
                    // La IA procesa los datos JSON y redacta una respuesta amable para el humano
                    const finalResult = await chat.sendMessage(functionResponse);
                    return res.json({ reply: finalResult.response.text() });

                } else {
                    // E. No se encontraron resultados
                    const functionError = [{
                        functionResponse: {
                            name: "buscar_documentos_erp",
                            response: { 
                                status: "sin_resultados", 
                                mensaje: `No se encontraron documentos en la base de datos para el cliente "${args.nombre_cliente}".` 
                            }
                        }
                    }];
                    const finalResult = await chat.sendMessage(functionError);
                    return res.json({ reply: finalResult.response.text() });
                }

            } catch (sqlError) {
                console.error("❌ Error SQL en Chat:", sqlError);
                return res.json({ reply: "Tuve un problema técnico al consultar la base de datos. Por favor intenta más tarde." });
            }
        }

        // Si la IA no quiso usar herramientas (charla normal), devolvemos su respuesta de texto
        res.json({ reply: response.text() });

    } catch (err) {
        console.error("❌ Error General Chat IA:", err);
        res.status(500).json({ error: "La IA tuvo un problema interno." });
    }
});

// --- RUTA FINAL CATCH-ALL (PARA REACT) ---
// Usamos /.*/ en lugar de '*' para que funcione en Express 5
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor CRM/ERP corriendo en http://localhost:${PORT}`);
});