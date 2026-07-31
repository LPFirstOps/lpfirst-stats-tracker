import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import * as schema from "./db/schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export type OrgAccess = {
  id: string;
  slug: string;
  name: string;
  role: string; // member | admin | owner | superadmin
};

/** Companies a user can read, with their role in each. Super admins get all. */
export async function accessibleOrgs(db: Db, userId: string): Promise<OrgAccess[]> {
  const u = await db.select().from(schema.user).where(eq(schema.user.id, userId)).get();

  if (u?.role === "admin") {
    const orgs = await db.select().from(schema.organization).all();
    return orgs.map((o) => ({ id: o.id, slug: o.slug, name: o.name, role: "superadmin" }));
  }

  const rows = await db
    .select({
      id: schema.organization.id,
      slug: schema.organization.slug,
      name: schema.organization.name,
      role: schema.member.role
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.member.organizationId, schema.organization.id))
    .where(eq(schema.member.userId, userId))
    .all();

  return rows;
}

/** Resolve a company slug to an org the user can access, or null. */
export function findOrg(orgs: OrgAccess[], slug: string): OrgAccess | null {
  return orgs.find((o) => o.slug === slug) ?? null;
}
