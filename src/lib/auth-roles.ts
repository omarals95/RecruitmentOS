import { createAccessControl } from "better-auth/plugins/access";
import {
  defaultStatements,
  ownerAc,
  adminAc,
} from "better-auth/plugins/organization/access";

export const ac = createAccessControl({ ...defaultStatements });
export const roles = {
  owner: ac.newRole({ ...ownerAc.statements }),
  // Ownership changes are reserved to owners by server hooks, independently of these UI permissions.
  admin: ac.newRole({ ...adminAc.statements }),
  recruiter: ac.newRole({}),
  viewer: ac.newRole({}),
};
