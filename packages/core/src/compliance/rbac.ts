/**
 * Role-based access control for Lattice compliance audit logs.
 *
 * Roles:
 * - admin: full access (view, export, verify, manage retention)
 * - auditor: view and export only (no deletion, no retention changes)
 * - viewer: view only (no export, no deletion)
 */

export type ComplianceRole = 'admin' | 'auditor' | 'viewer';

export interface CompliancePermission {
  canView: boolean;
  canExport: boolean;
  canVerify: boolean;
  canModifyRetention: boolean;
  canDelete: boolean;
}

const ROLE_PERMISSIONS: Record<ComplianceRole, CompliancePermission> = {
  admin: {
    canView: true,
    canExport: true,
    canVerify: true,
    canModifyRetention: true,
    canDelete: true,
  },
  auditor: {
    canView: true,
    canExport: true,
    canVerify: true,
    canModifyRetention: false,
    canDelete: false,
  },
  viewer: {
    canView: true,
    canExport: false,
    canVerify: false,
    canModifyRetention: false,
    canDelete: false,
  },
};

/**
 * Check if a role has the specified permission.
 */
export function hasPermission(role: ComplianceRole, permission: keyof CompliancePermission): boolean {
  return ROLE_PERMISSIONS[role][permission];
}

/**
 * Get all permissions for a role.
 */
export function getPermissions(role: ComplianceRole): CompliancePermission {
  return { ...ROLE_PERMISSIONS[role] };
}

/**
 * Enforce a permission check, throwing if the role doesn't have the permission.
 */
export function enforcePermission(
  role: ComplianceRole,
  permission: keyof CompliancePermission,
  action: string,
): void {
  if (!hasPermission(role, permission)) {
    throw new Error(`Access denied: role '${role}' cannot ${action}`);
  }
}
