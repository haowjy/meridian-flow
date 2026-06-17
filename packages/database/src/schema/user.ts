import type { ProjectId, UserId } from "@meridian/contracts";
import { pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { createdAt, jsonbDefault, updatedAt } from "./_shared";
import { projects } from "./content";
import { users } from "./users";

export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id")
    .$type<UserId>()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  preferences: jsonbDefault("preferences"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userProjectFavorites = pgTable(
  "user_project_favorites",
  {
    userId: uuid("user_id")
      .$type<UserId>()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .$type<ProjectId>()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.projectId] })],
);
