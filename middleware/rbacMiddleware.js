/**
 * Role-Based Access Control (RBAC) Middleware
 * 
 * RBAC Rules:
 * - super_admin: FULL access (view + create + edit + delete + send notifications + manage all admins)
 * - admin: FULL access (view + create + edit + delete + send notifications + manage all admins)
 * - co_admin: READ-ONLY access (can only view lists/pages, cannot create/edit/delete, cannot send notifications)
 */

/**
 * Check if user has write permissions (admin or super_admin only)
 * co_admin is restricted to read-only
 */
export const requireWriteAccess = (req, res, next) => {
  const userRole = req.user?.role;

  if (!userRole) {
    return res.status(401).json({ 
      message: "Not authorized",
      code: "UNAUTHORIZED"
    });
  }

  // Only admin and super_admin can write
  if (userRole !== "admin" && userRole !== "super_admin") {
    console.log(`[RBAC] Write access denied for role: ${userRole}`);
    return res.status(403).json({ 
      message: "Forbidden: Read-only access. You do not have permission to perform this action.",
      code: "FORBIDDEN_READ_ONLY"
    });
  }

  console.log(`[RBAC] Write access granted for role: ${userRole}`);
  next();
};

/**
 * Check if user is super_admin (for super-admin only operations)
 */
export const requireSuperAdmin = (req, res, next) => {
  const userRole = req.user?.role;

  if (!userRole) {
    return res.status(401).json({ 
      message: "Not authorized",
      code: "UNAUTHORIZED"
    });
  }

  if (userRole !== "super_admin") {
    console.log(`[RBAC] Super admin access denied for role: ${userRole}`);
    return res.status(403).json({ 
      message: "Forbidden: Only super-admins can perform this action.",
      code: "FORBIDDEN_SUPER_ADMIN_ONLY"
    });
  }

  console.log(`[RBAC] Super admin access granted`);
  next();
};

/**
 * Check if user can manage admin accounts
 * - super_admin: can manage all admins (co_admin, admin, super_admin)
 * - admin: can manage all admins (co_admin, admin, super_admin)
 * - co_admin: cannot manage any admins (read-only)
 */
export const canManageAdmin = (req, res, next) => {
  const userRole = req.user?.role;

  if (!userRole) {
    return res.status(401).json({ 
      message: "Not authorized",
      code: "UNAUTHORIZED"
    });
  }

  // co_admin cannot manage any admins
  if (userRole === "co_admin") {
    return res.status(403).json({ 
      message: "Forbidden: Read-only access. You cannot manage admin accounts.",
      code: "FORBIDDEN_READ_ONLY"
    });
  }

  // Both admin and super_admin can manage all admin types
  if (userRole === "admin" || userRole === "super_admin") {
    console.log(`[RBAC] Admin management access granted for role: ${userRole}`);
    next();
    return;
  }

  // Fallback (should not reach here if role checking is correct)
  return res.status(403).json({ 
    message: "Forbidden: You do not have permission to manage admin accounts.",
    code: "FORBIDDEN"
  });
};

