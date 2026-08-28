// Every id and size in the schema is an `INT` column, and Postgres errors on a bind past
// that range, so the ceiling is part of what makes a request well formed.
export const MAX_INT4 = 2_147_483_647;
