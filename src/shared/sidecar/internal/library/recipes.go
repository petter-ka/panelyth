package library

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Saved recipes of the image editor's batch mode (Stage 16, ADR-0036). A
// recipe is stored as the JSON the editor package validated; this package
// only keeps it, by a name that is unique without regard to case.
const (
	MaxRecipes     = 200
	MaxRecipeName  = 80
	MaxRecipeBytes = 256 << 10
)

// Recipe is one saved recipe.
type Recipe struct {
	ID        int64
	Name      string
	JSON      string
	UpdatedMs int64
}

func cleanRecipeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > MaxRecipeName || !utf8.ValidString(name) {
		return "", fmt.Errorf("%w: a recipe name is 1..%d characters", ErrInvalid, MaxRecipeName)
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("%w: a recipe name is one line of text", ErrInvalid)
		}
	}
	return name, nil
}

// Recipes lists the saved recipes by name.
func (l *Library) Recipes(ctx context.Context) ([]Recipe, error) {
	rows, err := l.db.QueryContext(ctx, `SELECT id, name, json, updated_at FROM recipes ORDER BY name_fold`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Recipe{}
	for rows.Next() {
		var r Recipe
		if err := rows.Scan(&r.ID, &r.Name, &r.JSON, &r.UpdatedMs); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// SaveRecipe stores a recipe under a name. With id 0 it is a new recipe, or
// replaces the one that has the name; with an id it changes that recipe
// (renaming it when the name differs), and fails with ErrDuplicate when
// another recipe has the name.
func (l *Library) SaveRecipe(ctx context.Context, id int64, name, json string) (Recipe, error) {
	name, err := cleanRecipeName(name)
	if err != nil {
		return Recipe{}, err
	}
	if json == "" || len(json) > MaxRecipeBytes {
		return Recipe{}, fmt.Errorf("%w: the recipe is too large", ErrInvalid)
	}
	fold := FoldTag(name)
	now := time.Now().UnixMilli()
	tx, err := l.db.BeginTx(ctx, nil)
	if err != nil {
		return Recipe{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var other int64
	switch err := tx.QueryRowContext(ctx, `SELECT id FROM recipes WHERE name_fold = ?`, fold).Scan(&other); {
	case errors.Is(err, sql.ErrNoRows):
		other = 0
	case err != nil:
		return Recipe{}, err
	}
	switch {
	case id > 0 && other != 0 && other != id:
		return Recipe{}, ErrDuplicate
	case id > 0:
		res, err := tx.ExecContext(ctx, `UPDATE recipes SET name = ?, name_fold = ?, json = ?, updated_at = ? WHERE id = ?`,
			name, fold, json, now, id)
		if err != nil {
			return Recipe{}, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return Recipe{}, ErrNotFound
		}
	case other != 0:
		id = other
		if _, err := tx.ExecContext(ctx, `UPDATE recipes SET name = ?, json = ?, updated_at = ? WHERE id = ?`,
			name, json, now, id); err != nil {
			return Recipe{}, err
		}
	default:
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM recipes`).Scan(&count); err != nil {
			return Recipe{}, err
		}
		if count >= MaxRecipes {
			return Recipe{}, fmt.Errorf("%w: there are %d recipes; delete one first", ErrInvalid, MaxRecipes)
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO recipes (name, name_fold, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
			name, fold, json, now, now)
		if err != nil {
			return Recipe{}, err
		}
		if id, err = res.LastInsertId(); err != nil {
			return Recipe{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Recipe{}, err
	}
	return Recipe{ID: id, Name: name, JSON: json, UpdatedMs: now}, nil
}

// DeleteRecipe removes a saved recipe.
func (l *Library) DeleteRecipe(ctx context.Context, id int64) error {
	res, err := l.db.ExecContext(ctx, `DELETE FROM recipes WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}
