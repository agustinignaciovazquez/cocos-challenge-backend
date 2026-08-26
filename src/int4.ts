// Every id and every size in the schema is an `INT` column, and Postgres answers a bind
// past that range with an error rather than an empty result. So the ceiling is part of
// what makes a request well formed, wherever a number of that kind is accepted or derived.
export const MAX_INT4 = 2_147_483_647;
