package database

import "fmt"

// TableNames holds the prefixed table names for the current environment
type TableNames struct {
	Projects  string
	Folders   string
	Documents string
}

// NewTableNames creates table names with the given prefix
func NewTableNames(prefix string) *TableNames {
	return &TableNames{
		Projects:  fmt.Sprintf("%sprojects", prefix),
		Folders:   fmt.Sprintf("%sfolders", prefix),
		Documents: fmt.Sprintf("%sdocuments", prefix),
	}
}

// GetTableName returns a prefixed table name
func (db *DB) GetTableName(baseName string) string {
	if db.Tables == nil {
		return baseName
	}
	
	switch baseName {
	case "projects":
		return db.Tables.Projects
	case "folders":
		return db.Tables.Folders
	case "documents":
		return db.Tables.Documents
	default:
		return baseName
	}
}

