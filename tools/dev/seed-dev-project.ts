import { contextSources, createDb, projects } from "@meridian/database";
import { and, eq, isNull } from "drizzle-orm";

export async function seedDevProject(
  databaseUrl: string,
  userId: string,
): Promise<string | null> {
  const db = createDb(databaseUrl);
  try {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.userId, userId), isNull(projects.deletedAt)))
      .limit(1);

    if (rows.length > 0) {
      return rows[0]?.id ?? null;
    }

    const [project] = await db
      .insert(projects)
      .values({
        userId,
        name: "My Serial",
        slug: "my-serial",
        systemPrompt: "You are a helpful writing assistant.",
      })
      .returning({ id: projects.id });

    if (!project) {
      return null;
    }

    await db.insert(contextSources).values([
      {
        projectId: project.id,
        name: "Filesystem",
        slug: "fs",
        scope: "project",
        adapterType: "local",
        isPrimary: true,
        sortOrder: 0,
      },
      {
        projectId: project.id,
        name: "Knowledge Base",
        slug: "kb",
        scope: "project",
        adapterType: "local",
        isPrimary: false,
        sortOrder: 1,
      },
    ]);

    return project.id;
  } finally {
    await db.close();
  }
}
