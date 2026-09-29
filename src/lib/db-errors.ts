// The unique constraint a failed insert or update broke, e.g. 'users_phone_unique', so the
// service can say which value is taken. Drizzle wraps the Postgres error in `cause`.
export function violatedUniqueConstraint(error: unknown): string | undefined {
  const pgError =
    error instanceof Error && error.cause && typeof error.cause === 'object' ? error.cause : error
  const { code, constraint } = pgError as { code?: string; constraint?: string }
  return code === '23505' ? constraint : undefined
}
