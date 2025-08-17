-- Schema Database Fantacalcio Asta
-- Esegui questo script in PgAdmin o psql

-- Tabella calciatori (con ID dal file Excel)
CREATE TABLE calciatori (
    id INTEGER PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    squadra VARCHAR(50) NOT NULL,
    ruolo CHAR(1) NOT NULL CHECK (ruolo IN ('P', 'D', 'C', 'A')),
    quotazione INTEGER NOT NULL,
    is_disponibile BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabella utenti
CREATE TABLE utenti (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    crediti_totali INTEGER DEFAULT 500,
    crediti_spesi INTEGER DEFAULT 0,
    is_admin BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabella aste
CREATE TABLE aste (
    id SERIAL PRIMARY KEY,
    calciatore_id INTEGER REFERENCES calciatori(id) ON DELETE CASCADE,
    stato VARCHAR(20) DEFAULT 'in_attesa' CHECK (stato IN ('in_attesa', 'attiva', 'chiusa')),
    tempo_fine TIMESTAMP,
    vincitore_id INTEGER REFERENCES utenti(id) ON DELETE SET NULL,
    prezzo_finale INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabella offerte
CREATE TABLE offerte (
    id SERIAL PRIMARY KEY,
    asta_id INTEGER REFERENCES aste(id) ON DELETE CASCADE,
    utente_id INTEGER REFERENCES utenti(id) ON DELETE CASCADE,
    importo INTEGER NOT NULL CHECK (importo > 0),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(asta_id, utente_id)  -- Un utente può fare solo un'offerta per asta
);

-- Tabella rose (calciatori acquistati)
CREATE TABLE rose (
    id SERIAL PRIMARY KEY,
    utente_id INTEGER REFERENCES utenti(id) ON DELETE CASCADE,
    calciatore_id INTEGER REFERENCES calciatori(id) ON DELETE CASCADE,
    prezzo_acquisto INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(utente_id, calciatore_id)  -- Un utente non può avere lo stesso calciatore due volte
);

-- Indici per performance
CREATE INDEX idx_calciatori_ruolo ON calciatori(ruolo);
CREATE INDEX idx_calciatori_squadra ON calciatori(squadra);
CREATE INDEX idx_calciatori_disponibili ON calciatori(is_disponibile);
CREATE INDEX idx_aste_stato ON aste(stato);
CREATE INDEX idx_aste_tempo_fine ON aste(tempo_fine);
CREATE INDEX idx_offerte_asta ON offerte(asta_id);
CREATE INDEX idx_rose_utente ON rose(utente_id);

-- Inserisci utente admin di default (password: admin123)
INSERT INTO utenti (username, email, password_hash, crediti_totali, is_admin) 
VALUES ('admin', 'admin@fantacalcio.com', '$2b$10$rOzJvZxXvKxbKxOeNxK.We8yVJXxH8XvJG1QJ2K3J4J5K6L7M8N9O0', 1000, true);

-- Commenti per chiarezza
COMMENT ON TABLE calciatori IS 'Calciatori della Serie A con quotazioni';
COMMENT ON TABLE utenti IS 'Utenti registrati al sistema';
COMMENT ON TABLE aste IS 'Aste per calciatori';
COMMENT ON TABLE offerte IS 'Offerte degli utenti per le aste';
COMMENT ON TABLE rose IS 'Calciatori acquistati da ogni utente';