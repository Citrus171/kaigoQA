import { HTTPException } from "hono/http-exception";

export type Role = "user" | "admin";

export interface Actor {
  id: string;
  role: Role;
}

/**
 * 認可の抽象（functest-freelance / 介護doc の Authorizer と同設計）。
 * Phase1 = role / 所有の直参照。Phase2 で OpenFGA 等の ReBAC へ呼び出し側無変更で差し替え可能。
 */
export interface Authorizer {
  requireRole(role: Role): void;
  canActOnOwned(ownerId: string): boolean;
  requireOwned(ownerId: string): void;
}

export class RbacAuthorizer implements Authorizer {
  constructor(private readonly actor: Actor) {}

  requireRole(role: Role): void {
    if (this.actor.role !== role) {
      throw new HTTPException(403, { message: `${role} 権限が必要です` });
    }
  }

  canActOnOwned(ownerId: string): boolean {
    return this.actor.role === "admin" || this.actor.id === ownerId;
  }

  requireOwned(ownerId: string): void {
    if (!this.canActOnOwned(ownerId)) {
      throw new HTTPException(403, { message: "権限がありません" });
    }
  }
}

export function toRole(value: unknown): Role {
  return value === "admin" ? "admin" : "user";
}
