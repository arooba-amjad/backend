# CORS Configuration Guide

## Overview

The backend uses CORS (Cross-Origin Resource Sharing) to control which frontend domains can access the API. This is essential for security when deploying to production.

## Configuration

CORS is configured in `backend/server.js` and uses the `CLIENT_ORIGIN` environment variable.

### Setting CLIENT_ORIGIN

In your backend `.env` file, set `CLIENT_ORIGIN` with comma-separated origins:

```env
CLIENT_ORIGIN=http://localhost:3000,https://your-site.netlify.app,https://yourdomain.com
```

### Development Setup

For local development, the default origins are:
- `http://localhost:3000`
- `http://localhost:3001`

If you're running on a different port, add it to `CLIENT_ORIGIN`.

### Production Setup

When deploying to production, you **must** set `CLIENT_ORIGIN` to include:

1. **Your Netlify domain**: `https://your-site.netlify.app`
2. **Your custom domain** (if applicable): `https://yourdomain.com`
3. **Any other frontend domains** you use

### Example Production .env

```env
CLIENT_ORIGIN=https://your-site.netlify.app,https://www.yourdomain.com,https://yourdomain.com
```

## How It Works

1. When a request comes in, the backend checks the `Origin` header
2. If the origin matches one in `CLIENT_ORIGIN`, the request is allowed
3. If not, CORS blocks the request and returns an error

## Common Issues

### "CORS blocked request" Error

**Problem**: Frontend can't connect to backend

**Solution**: 
1. Check your backend `.env` file has `CLIENT_ORIGIN` set
2. Make sure your frontend URL is in the `CLIENT_ORIGIN` list
3. Restart your backend server after changing `.env`

### Multiple Frontend Domains

If you have multiple frontend deployments (staging, production), add all of them:

```env
CLIENT_ORIGIN=http://localhost:3000,https://staging.yourdomain.com,https://yourdomain.com
```

### Wildcard Origins (Not Recommended)

For security reasons, we don't allow wildcard origins (`*`). Always specify exact domains.

## Testing CORS

1. Check backend logs on startup - it will show allowed origins
2. If a request is blocked, you'll see a warning in the logs
3. Check browser console for CORS errors

## Security Notes

- **Never** use `*` (wildcard) in production
- Always use HTTPS in production
- Only include trusted domains
- Keep your `.env` file secure and never commit it to git

## Deployment Platforms

### Heroku
Set environment variable in Heroku dashboard:
```bash
heroku config:set CLIENT_ORIGIN=https://your-site.netlify.app
```

### Railway
Set in Railway dashboard → Variables tab

### Render
Set in Render dashboard → Environment section

### Other Platforms
Set `CLIENT_ORIGIN` in your platform's environment variables configuration.




