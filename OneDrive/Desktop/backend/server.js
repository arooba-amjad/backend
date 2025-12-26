import http from "http";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Server } from "socket.io";
import authRoutes from "./routes/authRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import teacherRoutes from "./routes/teacherRoutes.js";
import studentRoutes from "./routes/studentRoutes.js";
import setupSocket from "./socket/socketHandler.js";
import createDefaultUsers from "./utils/createDefaultUsers.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

// CORS Configuration
// Set CLIENT_ORIGIN environment variable with comma-separated origins
// Example: CLIENT_ORIGIN=http://localhost:3000,https://your-site.netlify.app,https://yourdomain.com
const allowedOrigins =
  process.env.CLIENT_ORIGIN?.split(",").map((origin) => origin.trim()).filter(Boolean) || [];

// Default to localhost for development if no CLIENT_ORIGIN is set
const corsOrigins = allowedOrigins.length
  ? allowedOrigins
  : ["http://localhost:3000", "http://localhost:3001"];

// Log CORS configuration on startup (only essential info in production)
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) {
  console.log('🔒 CORS: Enabled for', corsOrigins.length, 'origin(s)');
  // Validate CORS configuration in production
  if (corsOrigins.length === 0) {
    console.error('❌ ERROR: CLIENT_ORIGIN must be set in production!');
    console.error('   Set CLIENT_ORIGIN environment variable with your frontend domain(s)');
    process.exit(1);
  }
  // Warn if localhost is in production CORS
  if (corsOrigins.some(origin => origin.includes('localhost'))) {
    console.warn('⚠️  WARNING: localhost detected in CLIENT_ORIGIN for production!');
    console.warn('   Remove localhost from CLIENT_ORIGIN in production environment');
  }
} else {
  console.log('🔒 CORS Configuration:');
  console.log(`   Allowed origins: ${corsOrigins.join(', ')}`);
  console.log(`   Credentials: enabled`);
  console.log(`   Methods: GET, POST, PUT, DELETE, PATCH, OPTIONS`);
}

const corsConfig = {
  origin: function (origin, callback) {
    // In production, reject requests with no origin for security
    // Only allow no-origin in development
    const isDevelopment = process.env.NODE_ENV !== 'production';
    
    if (!origin) {
      if (isDevelopment) {
        // Allow requests with no origin in development (e.g., Postman, curl)
        return callback(null, true);
      } else {
        // Reject in production for security
        console.warn('⚠️  CORS blocked request with no origin (production mode)');
        return callback(new Error('Not allowed by CORS. Origin header required.'));
      }
    }
    
    // Check if origin is in allowed list
    if (corsOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      if (isDevelopment) {
        console.warn(`⚠️  CORS blocked request from origin: ${origin}`);
        console.warn(`   Allowed origins: ${corsOrigins.join(', ')}`);
      }
      callback(new Error(`Not allowed by CORS. Origin: ${origin}`));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  exposedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204, // Some legacy browsers (IE11, various SmartTVs) choke on 204
  maxAge: 86400, // Cache preflight response for 24 hours
};

const io = new Server(server, {
  cors: corsConfig,
  transports: ['websocket', 'polling'],
  allowEIO3: true,
});

setupSocket(io);

app.set("io", io);

// Security headers middleware
const securityHeaders = (req, res, next) => {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY');
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');
  
  // Enable XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block');
  
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  // Content Security Policy (adjust based on your needs)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';"
    );
  }
  
  // Remove X-Powered-By header (security through obscurity)
  res.removeHeader('X-Powered-By');
  
  next();
};

app.use(securityHeaders);
app.use(cors(corsConfig));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Enhanced health check endpoint
app.get("/health", (_, res) => {
  res.json({ 
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/teacher", teacherRoutes);

// Add logging for student routes
app.use("/api/student", (req, res, next) => {
  console.log(`\n[STUDENT ROUTE] ${req.method} ${req.path}`);
  next();
}, studentRoutes);

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    console.log('Starting server...');
    
    // Check required environment variables
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('❌ Missing required Supabase configuration:');
      console.error('   SUPABASE_URL:', process.env.SUPABASE_URL ? '✅' : '❌ Missing');
      console.error('   SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅' : '❌ Missing');
      throw new Error('Missing required Supabase configuration. Check your .env file.');
    }
    
    if (!process.env.JWT_SECRET && !process.env.SUPABASE_JWT_SECRET) {
      console.error('❌ Missing JWT_SECRET or SUPABASE_JWT_SECRET');
      console.error('   Authentication will fail. Please set JWT_SECRET in your .env file.');
      throw new Error('Missing JWT_SECRET. Authentication requires JWT_SECRET or SUPABASE_JWT_SECRET.');
    }
    
    console.log('✅ Environment variables validated');
    console.log('Creating default users...');
  await createDefaultUsers();
    console.log('Default users check completed.');

  server.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      if (!isProduction) {
        console.log(`🌐 API available at http://localhost:${PORT}/api`);
      } else {
        console.log(`🌐 API available at /api`);
        console.log(`📊 Health check: /health`);
      }
    });

    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Please stop the other process or use a different port.`);
      } else {
        console.error('❌ Server error:', error);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    console.error('Error details:', error.message);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

startServer();

