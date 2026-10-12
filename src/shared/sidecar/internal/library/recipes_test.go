package library

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestRecipes(t *testing.T) {
	l, _ := open(t)
	if got, err := l.Recipes(ctx); err != nil || len(got) != 0 {
		t.Fatalf("empty: %v %v", got, err)
	}
	a, err := l.SaveRecipe(ctx, 0, " Web ", `{"version":1}`)
	if err != nil || a.ID == 0 || a.Name != "Web" {
		t.Fatalf("save: %+v %v", a, err)
	}
	b, err := l.SaveRecipe(ctx, 0, "Árvíz", `{"version":1,"ops":[]}`)
	if err != nil {
		t.Fatal(err)
	}
	// The same name, whatever its case, is the same recipe.
	again, err := l.SaveRecipe(ctx, 0, "WEB", `{"version":2}`)
	if err != nil || again.ID != a.ID {
		t.Fatalf("replace: %+v %v", again, err)
	}
	if _, err := l.SaveRecipe(ctx, 0, "ÁRVÍZ", `{}`); err != nil {
		t.Errorf("fold of a non-ASCII name: %v", err)
	}
	got, _ := l.Recipes(ctx)
	if len(got) != 2 || got[0].Name != "WEB" || got[1].Name != "ÁRVÍZ" || got[0].JSON != `{"version":2}` || got[0].UpdatedMs == 0 {
		t.Fatalf("list: %+v", got)
	}
	if _, err := l.SaveRecipe(ctx, b.ID, "web", `{}`); !errors.Is(err, ErrDuplicate) {
		t.Errorf("rename onto another: %v", err)
	}
	if r, err := l.SaveRecipe(ctx, b.ID, "Flood", `{}`); err != nil || r.ID != b.ID {
		t.Errorf("rename: %+v %v", r, err)
	}
	if _, err := l.SaveRecipe(ctx, 4242, "Nobody", `{}`); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
	for name, args := range map[string][2]string{
		"empty name": {"  ", `{}`},
		"long name":  {strings.Repeat("x", MaxRecipeName+1), `{}`},
		"two lines":  {"a\nb", `{}`},
		"empty json": {"ok", ""},
		"huge json":  {"ok", strings.Repeat("x", MaxRecipeBytes+1)},
	} {
		if _, err := l.SaveRecipe(ctx, 0, args[0], args[1]); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if err := l.DeleteRecipe(ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if err := l.DeleteRecipe(ctx, a.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("delete twice: %v", err)
	}
}

func TestRecipesAreBounded(t *testing.T) {
	l, _ := open(t)
	for i := range MaxRecipes {
		if _, err := l.SaveRecipe(ctx, 0, fmt.Sprintf("r%03d", i), `{}`); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := l.SaveRecipe(ctx, 0, "one more", `{}`); !errors.Is(err, ErrInvalid) {
		t.Errorf("over the limit: %v", err)
	}
	// Changing one of them still works.
	if _, err := l.SaveRecipe(ctx, 0, "r000", `{"a":1}`); err != nil {
		t.Errorf("replace at the limit: %v", err)
	}
}
