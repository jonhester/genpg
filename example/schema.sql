CREATE TYPE account_status AS ENUM ('active', 'suspended', 'closed');

CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  full_name  text,
  status     account_status NOT NULL DEFAULT 'active',
  tags       text[],
  created_at timestamptz NOT NULL DEFAULT now()
);
