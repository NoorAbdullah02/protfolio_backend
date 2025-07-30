require("dotenv").config();  // Load environment variables

const http = require("http");
const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless"); // Neon serverless package

// Validate environment variables
if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is not set!");
  console.log("Please create a .env file with your Neon database URL:");
  console.log("DATABASE_URL=postgresql://username:password@host/database?sslmode=require");
  process.exit(1);
}

// Connect to Neon PostgreSQL database using the connection string from .env file
const sql = neon(process.env.DATABASE_URL);

// Test database connection
const testConnection = async () => {
  try {
    const result = await sql`SELECT NOW() as current_time`;
    console.log("✅ Database connected successfully at:", result[0].current_time);
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    console.log("Please check your DATABASE_URL in the .env file");
  }
};

// Function to serve static files (like contact.html, CSS, JS)
const serveStaticFile = (res, filePath, contentType) => {
  console.log("Serving file from:", filePath);
  fs.readFile(filePath, (err, content) => {
    if (err) {
      console.error("Error reading file:", err);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("File not found");
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content, "utf-8");
    }
  });
};

// Function to check if table exists and has correct structure
const checkTableStructure = async () => {
  try {
    // Check if table exists and get its structure
    const tableInfo = await sql`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'contacts' 
      ORDER BY ordinal_position
    `;
    
    console.log("Current table structure:", tableInfo);
    return tableInfo;
  } catch (error) {
    console.error("❌ Error checking table structure:", error);
    return [];
  }
};

// Function to create or recreate the contacts table
const createTable = async () => {
  try {
    // First, check current table structure
    const existingColumns = await checkTableStructure();
    
    // Check if created_at column exists
    const hasCreatedAt = existingColumns.some(col => col.column_name === 'created_at');
    
    if (!hasCreatedAt && existingColumns.length > 0) {
      console.log("⚠️  Table exists but missing created_at column. Adding it...");
      
      // Add the missing created_at column
      await sql`
        ALTER TABLE contacts 
        ADD COLUMN created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      `;
      console.log("✅ Added created_at column to existing table.");
    } else {
      // Create table if it doesn't exist
      await sql`
        CREATE TABLE IF NOT EXISTS contacts (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) NOT NULL,
          phone VARCHAR(20),
          message TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
      `;
      console.log("✅ Contacts table created or already exists.");
    }
    
    // Create indexes separately to avoid multiple commands in one statement
    try {
      await sql`CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)`;
      console.log("✅ Email index created.");
    } catch (indexError) {
      console.log("⚠️  Email index may already exist:", indexError.message);
    }
    
    try {
      await sql`CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at)`;
      console.log("✅ Created_at index created.");
    } catch (indexError) {
      console.log("⚠️  Created_at index may already exist:", indexError.message);
    }
    
    // Verify final table structure
    const finalStructure = await checkTableStructure();
    console.log("✅ Final table structure verified:", finalStructure.map(col => col.column_name));
    
  } catch (error) {
    console.error("❌ Error creating contacts table:", error);
  }
};

// Function to insert a contact into the table
const saveContact = async (name, email, phone, message) => {
  try {
    console.log("Attempting to save contact:", { name, email, phone: phone || 'N/A' });
    
    // Insert the contact and return only the id (created_at will be set by default)
    const result = await sql`
      INSERT INTO contacts (name, email, phone, message)
      VALUES (${name}, ${email}, ${phone || null}, ${message})
      RETURNING id
    `;
    
    console.log("✅ Contact saved successfully with ID:", result[0].id);
    return { 
      status: 'success', 
      message: 'Thank you! Your message has been sent successfully.',
      id: result[0].id
    };
    
  } catch (error) {
    console.error("❌ Error saving contact:", error);
    
    // Handle specific database errors
    if (error.code === '23505') { // Unique violation
      if (error.constraint?.includes('email')) {
        return { 
          status: 'error', 
          message: 'This email address has already been used. Please use a different email.' 
        };
      } else if (error.constraint?.includes('phone')) {
        return { 
          status: 'error', 
          message: 'This phone number has already been used. Please use a different number.' 
        };
      }
    }
    
    return { 
      status: 'error', 
      message: 'Something went wrong while saving your contact. Please try again later.' 
    };
  }
};

// Request handler for HTTP server
const requestHandler = async (req, res) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  
  // Set CORS headers for frontend communication
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Serve the contact.html file when root URL is accessed
  // Go up one level from Backend folder to reach contact.html
  if (req.method === "GET" && req.url === "/") {
    const filePath = path.join(__dirname, "..", "contact.html");
    serveStaticFile(res, filePath, "text/html");
    return;
  }

  // Serve CSS files
  if (req.method === "GET" && req.url.startsWith("/css/")) {
    const filePath = path.join(__dirname, "..", req.url);
    serveStaticFile(res, filePath, "text/css");
    return;
  }

  // Serve JS files
  if (req.method === "GET" && req.url.startsWith("/js/")) {
    const filePath = path.join(__dirname, "..", req.url);
    serveStaticFile(res, filePath, "application/javascript");
    return;
  }

  // Serve image files
  if (req.method === "GET" && req.url.startsWith("/images/")) {
    const filePath = path.join(__dirname, "..", req.url);
    const ext = path.extname(filePath).toLowerCase();
    let contentType = "application/octet-stream";
    
    if (ext === ".png") contentType = "image/png";
    else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    else if (ext === ".gif") contentType = "image/gif";
    else if (ext === ".svg") contentType = "image/svg+xml";
    
    serveStaticFile(res, filePath, contentType);
    return;
  }

  // Handle POST request to /submit-contact
  if (req.method === 'POST' && req.url === '/submit-contact') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', async () => {
      try {
        console.log("Raw request body:", body);
        
        if (!body.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ 
            status: 'error', 
            message: 'No data received. Please try again.' 
          }));
          return;
        }

        const data = JSON.parse(body);
        const { name, email, phone, message } = data;
        
        console.log('Parsed data:', { name, email, phone, message });

        // Server-side validation
        if (!name?.trim() || !email?.trim() || !message?.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ 
            status: 'error', 
            message: 'Name, email, and message are required fields.' 
          }));
          return;
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ 
            status: 'error', 
            message: 'Please enter a valid email address.' 
          }));
          return;
        }

        // Save contact data to Neon PostgreSQL
        const response = await saveContact(
          name.trim(), 
          email.trim().toLowerCase(), 
          phone?.trim() || null, 
          message.trim()
        );

        // Send response
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        
      } catch (error) {
        console.error("❌ Error processing request:", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          status: 'error', 
          message: 'Server error. Please try again later.' 
        }));
      }
    });
    return;
  }

  // Handle 404 for other routes
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ 
    status: 'error', 
    message: 'Page not found' 
  }));
};

// Initialize server
const startServer = async () => {
  try {
    // Test database connection
    await testConnection();
    
    // Create the table when the server starts
    await createTable();
    
    // Create and start the HTTP server
    const server = http.createServer(requestHandler);
    
    const PORT = process.env.PORT || 3000;
    
    // Handle port already in use
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`⚠️  Port ${PORT} is busy, trying port ${PORT + 1}...`);
        server.listen(PORT + 1, () => {
          console.log(`🚀 Server running at http://localhost:${PORT + 1}`);
          console.log(`📧 Contact form endpoint: http://localhost:${PORT + 1}/submit-contact`);
          console.log("💾 Database: Connected to Neon PostgreSQL");
          console.log("📁 Serving contact.html from parent directory");
          console.log("⏰ Server started at:", new Date().toISOString());
        });
      } else {
        console.error("❌ Server error:", err);
        process.exit(1);
      }
    });
    
    server.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
      console.log(`📧 Contact form endpoint: http://localhost:${PORT}/submit-contact`);
      console.log("💾 Database: Connected to Neon PostgreSQL");
      console.log("📁 Serving contact.html from parent directory");
      console.log("⏰ Server started at:", new Date().toISOString());
    });
    
    // Handle server shutdown gracefully
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down server...');
      server.close(() => {
        console.log('✅ Server closed.');
        process.exit(0);
      });
    });
    
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

// Start the server
startServer();