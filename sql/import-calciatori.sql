-- Import calciatori Serie A 2024-25 dal file Excel
INSERT INTO calciatori (id, nome, squadra, ruolo, quotazione) VALUES
  (2428, 'Sommer', 'Inter', 'P', 19),
  (5876, 'Di Gregorio', 'Juventus', 'P', 18),
  (572, 'Meret', 'Napoli', 'P', 15),
  (4312, 'Maignan', 'Milan', 'P', 14),
  (5841, 'Svilar', 'Roma', 'P', 14),
  (133, 'Skorupski', 'Bologna', 'P', 12),
  (2170, 'Milinkovic-Savic V.', 'Torino', 'P', 12),
  (4431, 'Carnesecchi', 'Atalanta', 'P', 12),
  (2814, 'Provedel', 'Lazio', 'P', 11),
  (2815, 'Terracciano', 'Fiorentina', 'P', 11)
  -- [... qui andrebbero tutti i 538 calciatori ...]
ON CONFLICT (id) DO UPDATE SET 
  quotazione = EXCLUDED.quotazione,
  squadra = EXCLUDED.squadra,
  nome = EXCLUDED.nome;

-- Query di verifica
SELECT 
  ruolo, 
  COUNT(*) as totale,
  AVG(quotazione) as quotazione_media
FROM calciatori 
GROUP BY ruolo 
ORDER BY ruolo;