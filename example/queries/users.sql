-- name: GetUser :one
SELECT id, email, full_name, status, tags, created_at
FROM users
WHERE id = @id;

-- name: ListUsersByStatus :many
SELECT id, email, status
FROM users
WHERE status = @status
ORDER BY created_at DESC;

-- name: CreateUser :one
INSERT INTO users (email, full_name)
VALUES (@email, @full_name)
RETURNING id, email, created_at;

-- name: ListCreatedSince :many
SELECT id, email, created_at
FROM users
WHERE created_at >= @since
ORDER BY created_at DESC;

-- name: UsersByIds :many
SELECT id, email FROM users WHERE id IN @ids(array);

-- name: BulkCreateUsers :execrows
INSERT INTO users (email, full_name) VALUES @rows(spread);

-- name: UpdateStatus :execrows
UPDATE users SET status = @status WHERE id = @id;

-- name: DeleteUser :exec
DELETE FROM users WHERE id = @id;
