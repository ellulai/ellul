import { z } from "zod";

// Structural fields validated by Zod for the TS data file. Translatable
// strings (name, bio, jobTitle) live in
// `packages/i18n-messages/messages/{locale}/authors.json` and are composed
// in by the loader at request time.
export const AuthorSchema = z.object({
  handle: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "handle must be lowercase, hyphenated"),
  avatar: z.string().startsWith("/").optional(),
  url: z.string().url().optional(),
  twitter: z.string().regex(/^@?[a-zA-Z0-9_]{1,15}$/).optional(),
  github: z.string().regex(/^[a-zA-Z0-9-]{1,39}$/).optional(),
});

export type AuthorStructural = z.infer<typeof AuthorSchema>;

export interface Author extends AuthorStructural {
  name: string;
  bio: string;
  jobTitle?: string;
}

export function defineAuthor(input: AuthorStructural): AuthorStructural {
  return AuthorSchema.parse(input);
}
