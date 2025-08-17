const express = require('express');
const bcrypt = require('bcryptjs'); 
const { query, transaction } = require('../config/database');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');

// Tutti gli endpoint admin richiedono autenticazione + privilegi admin
router.use(authenticateToken, requireAdmin);

// PUT /api/admin/utenti/:id - Modifica utente (solo admin)
router.put('/utenti/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { username, email, password, crediti_totali, is_admin } = req.body;

        // Verifica che l'utente esista
        const utenteResult = await query('SELECT id FROM utenti WHERE id = $1', [id]);
        if (utenteResult.rows.length === 0) {
            return res.status(404).json({ error: 'Utente non trovato' });
        }

        // Prepara i campi da aggiornare
        let updateFields = [];
        let updateValues = [];
        let paramCount = 1;

        if (username) {
            // Verifica unicità username
            const existingUser = await query(
                'SELECT id FROM utenti WHERE username = $1 AND id != $2', 
                [username, id]
            );
            if (existingUser.rows.length > 0) {
                return res.status(400).json({ error: 'Username già in uso' });
            }
            updateFields.push(`username = $${paramCount++}`);
            updateValues.push(username);
        }

        if (email) {
            // Verifica unicità email
            const existingEmail = await query(
                'SELECT id FROM utenti WHERE email = $1 AND id != $2', 
                [email, id]
            );
            if (existingEmail.rows.length > 0) {
                return res.status(400).json({ error: 'Email già in uso' });
            }
            updateFields.push(`email = $${paramCount++}`);
            updateValues.push(email);
        }

        if (password) {
            // Hash della nuova password
            const hashedPassword = await bcrypt.hash(password, 12);
            updateFields.push(`password_hash = $${paramCount++}`);
            updateValues.push(hashedPassword);
        }

        if (crediti_totali !== undefined) {
            updateFields.push(`crediti_totali = $${paramCount++}`);
            updateValues.push(crediti_totali);
        }

        if (is_admin !== undefined) {
            updateFields.push(`is_admin = $${paramCount++}`);
            updateValues.push(is_admin);
        }

        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'Nessun campo da aggiornare' });
        }

        // Esegui l'aggiornamento
        updateValues.push(id); // ID per la WHERE clause
        const updateQuery = `
            UPDATE utenti 
            SET ${updateFields.join(', ')} 
            WHERE id = $${paramCount}
            RETURNING id, username, email, crediti_totali, is_admin
        `;

        const result = await query(updateQuery, updateValues);

        res.json({
            message: 'Utente aggiornato con successo',
            utente: result.rows[0]
        });

    } catch (error) {
        console.error('Errore aggiornamento utente:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// DELETE /api/admin/utenti/:id - Elimina utente (solo admin)
router.delete('/utenti/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Non permettere di eliminare se stesso
        if (parseInt(id) === req.user.id) {
            return res.status(400).json({ error: 'Non puoi eliminare il tuo account' });
        }

        const result = await transaction(async (client) => {
            // Verifica che l'utente esista
            const utenteResult = await client.query(
                'SELECT username FROM utenti WHERE id = $1', 
                [id]
            );

            if (utenteResult.rows.length === 0) {
                throw new Error('Utente non trovato');
            }

            const username = utenteResult.rows[0].username;

            // 🔧 CORREZIONE: Prima libera i calciatori dell'utente
            const calciatoriLiberati = await client.query(`
                SELECT c.id, c.nome 
                FROM rose r 
                JOIN calciatori c ON r.calciatore_id = c.id 
                WHERE r.utente_id = $1
            `, [id]);

            if (calciatoriLiberati.rows.length > 0) {
                // Libera i calciatori (li rende di nuovo disponibili per le aste)
                await client.query(`
                    UPDATE calciatori 
                    SET is_disponibile = true 
                    WHERE id IN (
                        SELECT calciatore_id 
                        FROM rose 
                        WHERE utente_id = $1
                    )
                `, [id]);

                console.log(`🔓 Liberati ${calciatoriLiberati.rows.length} calciatori per eliminazione utente ${username}:`, 
                    calciatoriLiberati.rows.map(c => c.nome).join(', '));
            }

            // Elimina prima le offerte dell'utente
            await client.query('DELETE FROM offerte WHERE utente_id = $1', [id]);

            // Elimina la rosa dell'utente (ora che i calciatori sono stati liberati)
            await client.query('DELETE FROM rose WHERE utente_id = $1', [id]);

            // Rimuovi l'utente come vincitore dalle aste
            await client.query('UPDATE aste SET vincitore_id = NULL WHERE vincitore_id = $1', [id]);

            // Infine elimina l'utente
            await client.query('DELETE FROM utenti WHERE id = $1', [id]);

            return { 
                username, 
                calciatoriLiberati: calciatoriLiberati.rows.length,
                giocatoriNomi: calciatoriLiberati.rows.map(c => c.nome)
            };
        });

        res.json({
            message: `Utente ${result.username} eliminato con successo`,
            dettagli: result.calciatoriLiberati > 0 ? 
                `${result.calciatoriLiberati} calciatori liberati e di nuovo disponibili per le aste: ${result.giocatoriNomi.join(', ')}` :
                'Nessun calciatore da liberare'
        });

    } catch (error) {
        console.error('Errore eliminazione utente:', error);
        
        if (error.message === 'Utente non trovato') {
            return res.status(404).json({ error: error.message });
        }
        
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/admin/stats - Statistiche admin
router.get('/stats', async (req, res) => {
    try {
        // Statistiche generali
        const statsResult = await query(`
            SELECT 
                COUNT(DISTINCT u.id) as total_users,
                COUNT(DISTINCT a.id) as total_auctions,
                COALESCE(SUM(r.prezzo_acquisto), 0) as total_spent,
                COALESCE(AVG(r.prezzo_acquisto), 0) as avg_spent,
                COUNT(DISTINCT r.id) as total_players_bought
            FROM utenti u
            CROSS JOIN aste a
            CROSS JOIN rose r
        `);

        // Statistiche per ruolo
        const roleStatsResult = await query(`
            SELECT 
                c.ruolo,
                COUNT(r.id) as giocatori_acquistati,
                AVG(r.prezzo_acquisto) as prezzo_medio,
                MAX(r.prezzo_acquisto) as prezzo_massimo
            FROM rose r
            JOIN calciatori c ON r.calciatore_id = c.id
            GROUP BY c.ruolo
            ORDER BY c.ruolo
        `);

        // Ultimi acquisti
        const recentPurchasesResult = await query(`
            SELECT 
                u.username,
                c.nome as calciatore_nome,
                c.squadra,
                c.ruolo,
                r.prezzo_acquisto,
                r.created_at
            FROM rose r
            JOIN utenti u ON r.utente_id = u.id
            JOIN calciatori c ON r.calciatore_id = c.id
            ORDER BY r.created_at DESC
            LIMIT 10
        `);

        res.json({
            statistiche_generali: statsResult.rows[0],
            statistiche_ruoli: roleStatsResult.rows,
            acquisti_recenti: recentPurchasesResult.rows
        });

    } catch (error) {
        console.error('Errore recupero statistiche admin:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// POST /api/admin/reset-password/:id - Reset password utente
router.post('/reset-password/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { new_password } = req.body;

        if (!new_password || new_password.length < 6) {
            return res.status(400).json({ error: 'Password deve essere di almeno 6 caratteri' });
        }

        // Verifica che l'utente esista
        const utenteResult = await query(
            'SELECT username FROM utenti WHERE id = $1', 
            [id]
        );

        if (utenteResult.rows.length === 0) {
            return res.status(404).json({ error: 'Utente non trovato' });
        }

        // ✅ CORREZIONE: Hash della password invece di salvarla in chiaro
        const hashedPassword = await bcrypt.hash(new_password, 12);
        await query(
            'UPDATE utenti SET password_hash = $1 WHERE id = $2',
            [hashedPassword, id]
        );

        res.json({
            message: `Password di ${utenteResult.rows[0].username} resettata con successo`
        });

    } catch (error) {
        console.error('Errore reset password:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// POST /api/admin/bulk-credits - Modifica crediti di massa
router.post('/bulk-credits', async (req, res) => {
    try {
        const { crediti_aggiuntivi, solo_non_admin } = req.body;

        if (!crediti_aggiuntivi || crediti_aggiuntivi === 0) {
            return res.status(400).json({ error: 'Specificare i crediti aggiuntivi' });
        }

        let whereClause = '';
        if (solo_non_admin) {
            whereClause = 'WHERE is_admin = false';
        }

        const result = await query(`
            UPDATE utenti 
            SET crediti_totali = crediti_totali + $1
            ${whereClause}
            RETURNING username, crediti_totali
        `, [crediti_aggiuntivi]);

        res.json({
            message: `Crediti aggiornati per ${result.rows.length} utenti`,
            utenti_aggiornati: result.rows
        });

    } catch (error) {
        console.error('Errore aggiornamento crediti massa:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// POST /api/admin/assegna-giocatore - Assegnazione manuale giocatore
router.post('/assegna-giocatore', async (req, res) => {
    try {
        const { calciatore_id, utente_id, prezzo_acquisto } = req.body;

        // Validazione input
        if (!calciatore_id || !utente_id || !prezzo_acquisto) {
            return res.status(400).json({ 
                error: 'Calciatore, utente e prezzo sono obbligatori' 
            });
        }

        if (prezzo_acquisto <= 0) {
            return res.status(400).json({ 
                error: 'Il prezzo deve essere maggiore di 0' 
            });
        }

        const result = await transaction(async (client) => {
            // Verifica che il calciatore esista e sia disponibile
            const calciatoreResult = await client.query(
                'SELECT id, nome, is_disponibile FROM calciatori WHERE id = $1',
                [calciatore_id]
            );

            if (calciatoreResult.rows.length === 0) {
                throw new Error('Calciatore non trovato');
            }

            const calciatore = calciatoreResult.rows[0];

            // Verifica che il calciatore non sia già stato acquistato
            const esisteRosa = await client.query(
                'SELECT id FROM rose WHERE calciatore_id = $1',
                [calciatore_id]
            );

            if (esisteRosa.rows.length > 0) {
                throw new Error('Questo calciatore è già stato acquistato da un altro utente');
            }

            // Verifica che l'utente esista
            const utenteResult = await client.query(
                'SELECT id, username, crediti_totali, crediti_spesi FROM utenti WHERE id = $1',
                [utente_id]
            );

            if (utenteResult.rows.length === 0) {
                throw new Error('Utente non trovato');
            }

            const utente = utenteResult.rows[0];
            const creditiDisponibili = utente.crediti_totali - (utente.crediti_spesi || 0);

            // Verifica che l'utente abbia crediti sufficienti
            if (creditiDisponibili < prezzo_acquisto) {
                throw new Error(`${utente.username} non ha crediti sufficienti. Disponibili: ${creditiDisponibili}, Richiesti: ${prezzo_acquisto}`);
            }

            // Aggiungi il calciatore alla rosa dell'utente
            await client.query(`
                INSERT INTO rose (utente_id, calciatore_id, prezzo_acquisto, created_at)
                VALUES ($1, $2, $3, NOW())
            `, [utente_id, calciatore_id, prezzo_acquisto]);

            // Aggiorna i crediti spesi dell'utente
            await client.query(`
                UPDATE utenti 
                SET crediti_spesi = COALESCE(crediti_spesi, 0) + $1
                WHERE id = $2
            `, [prezzo_acquisto, utente_id]);

            // Segna il calciatore come non disponibile
            await client.query(
                'UPDATE calciatori SET is_disponibile = false WHERE id = $1',
                [calciatore_id]
            );

            return {
                calciatore: calciatore.nome,
                utente: utente.username,
                prezzo: prezzo_acquisto
            };
        });

        console.log(`👤 Admin ${req.user.username} ha assegnato manualmente ${result.calciatore} a ${result.utente} per ${result.prezzo} crediti`);

        res.json({
            message: `${result.calciatore} assegnato con successo a ${result.utente} per ${result.prezzo} crediti`,
            assegnazione: result
        });

    } catch (error) {
        console.error('Errore assegnazione manuale:', error);
        
        if (error.message.includes('non trovato') || 
            error.message.includes('già stato acquistato') ||
            error.message.includes('non ha crediti sufficienti')) {
            return res.status(400).json({ error: error.message });
        }
        
        res.status(500).json({ error: 'Errore interno del server' });
    }
});
// POST /api/admin/trasferisci-giocatore - Trasferimento giocatore
router.post('/trasferisci-giocatore', async (req, res) => {
    try {
        const { calciatore_id, nuovo_utente_id, nuovo_prezzo } = req.body;

        // Validazione input
        if (!calciatore_id || !nuovo_utente_id || !nuovo_prezzo) {
            return res.status(400).json({ 
                error: 'Calciatore, nuovo utente e prezzo sono obbligatori' 
            });
        }

        if (nuovo_prezzo <= 0) {
            return res.status(400).json({ 
                error: 'Il prezzo deve essere maggiore di 0' 
            });
        }

        const result = await transaction(async (client) => {
            // Verifica che il calciatore esista e sia assegnato
            const calciatoreResult = await client.query(`
                SELECT c.id, c.nome, r.utente_id as vecchio_utente_id, r.prezzo_acquisto as vecchio_prezzo
                FROM calciatori c
                JOIN rose r ON c.id = r.calciatore_id
                WHERE c.id = $1
            `, [calciatore_id]);

            if (calciatoreResult.rows.length === 0) {
                throw new Error('Calciatore non trovato o non assegnato');
            }

            const calciatore = calciatoreResult.rows[0];

            // Verifica che il nuovo utente esista
            const nuovoUtenteResult = await client.query(`
                SELECT id, username, crediti_totali, crediti_spesi 
                FROM utenti 
                WHERE id = $1
            `, [nuovo_utente_id]);

            if (nuovoUtenteResult.rows.length === 0) {
                throw new Error('Nuovo utente non trovato');
            }

            const nuovoUtente = nuovoUtenteResult.rows[0];
            const creditiDisponibili = nuovoUtente.crediti_totali - (nuovoUtente.crediti_spesi || 0);

            // Verifica che il nuovo utente abbia crediti sufficienti
            if (creditiDisponibili < nuovo_prezzo) {
                throw new Error(`${nuovoUtente.username} non ha crediti sufficienti. Disponibili: ${creditiDisponibili}, Richiesti: ${nuovo_prezzo}`);
            }

            // Recupera info del vecchio utente
            const vecchioUtenteResult = await client.query(`
                SELECT username FROM utenti WHERE id = $1
            `, [calciatore.vecchio_utente_id]);

            const vecchioUtente = vecchioUtenteResult.rows[0];

            // Aggiorna la rosa: cambia proprietario e prezzo
            await client.query(`
                UPDATE rose 
                SET utente_id = $1, prezzo_acquisto = $2, created_at = NOW()
                WHERE calciatore_id = $3
            `, [nuovo_utente_id, nuovo_prezzo, calciatore_id]);

            // Aggiorna crediti del vecchio proprietario (recupera i crediti)
            await client.query(`
                UPDATE utenti 
                SET crediti_spesi = crediti_spesi - $1
                WHERE id = $2
            `, [calciatore.vecchio_prezzo, calciatore.vecchio_utente_id]);

            // Aggiorna crediti del nuovo proprietario (spende i crediti)
            await client.query(`
                UPDATE utenti 
                SET crediti_spesi = COALESCE(crediti_spesi, 0) + $1
                WHERE id = $2
            `, [nuovo_prezzo, nuovo_utente_id]);

            return {
                calciatore: calciatore.nome,
                vecchio_proprietario: vecchioUtente.username,
                nuovo_proprietario: nuovoUtente.username,
                vecchio_prezzo: calciatore.vecchio_prezzo,
                nuovo_prezzo: nuovo_prezzo
            };
        });

        console.log(`🔄 Admin ${req.user.username} ha trasferito ${result.calciatore} da ${result.vecchio_proprietario} a ${result.nuovo_proprietario} (${result.vecchio_prezzo} → ${result.nuovo_prezzo} crediti)`);

        res.json({
            message: `${result.calciatore} trasferito da ${result.vecchio_proprietario} a ${result.nuovo_proprietario}`,
            dettagli: `Prezzo: ${result.vecchio_prezzo} → ${result.nuovo_prezzo} crediti`,
            trasferimento: result
        });

    } catch (error) {
        console.error('Errore trasferimento giocatore:', error);
        
        if (error.message.includes('non trovato') || 
            error.message.includes('non assegnato') ||
            error.message.includes('non ha crediti sufficienti')) {
            return res.status(400).json({ error: error.message });
        }
        
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// POST /api/admin/libera-giocatore - Libera giocatore dalla rosa
router.post('/libera-giocatore', async (req, res) => {
    try {
        const { calciatore_id } = req.body;

        if (!calciatore_id) {
            return res.status(400).json({ 
                error: 'ID calciatore richiesto' 
            });
        }

        const result = await transaction(async (client) => {
            // Verifica che il calciatore esista e sia assegnato
            const calciatoreResult = await client.query(`
                SELECT c.id, c.nome, r.utente_id, r.prezzo_acquisto, u.username
                FROM calciatori c
                JOIN rose r ON c.id = r.calciatore_id
                JOIN utenti u ON r.utente_id = u.id
                WHERE c.id = $1
            `, [calciatore_id]);

            if (calciatoreResult.rows.length === 0) {
                throw new Error('Calciatore non trovato o non assegnato');
            }

            const calciatore = calciatoreResult.rows[0];

            // Rimuovi dalla rosa
            await client.query(`
                DELETE FROM rose WHERE calciatore_id = $1
            `, [calciatore_id]);

            // Restituisci i crediti al proprietario
            await client.query(`
                UPDATE utenti 
                SET crediti_spesi = crediti_spesi - $1
                WHERE id = $2
            `, [calciatore.prezzo_acquisto, calciatore.utente_id]);

            // Rendi il calciatore disponibile per nuove aste
            await client.query(`
                UPDATE calciatori 
                SET is_disponibile = true
                WHERE id = $1
            `, [calciatore_id]);

            return {
                calciatore: calciatore.nome,
                ex_proprietario: calciatore.username,
                crediti_restituiti: calciatore.prezzo_acquisto
            };
        });

        console.log(`🆓 Admin ${req.user.username} ha liberato ${result.calciatore} da ${result.ex_proprietario} (restituiti ${result.crediti_restituiti} crediti)`);

        res.json({
            message: `${result.calciatore} liberato con successo`,
            dettagli: `${result.crediti_restituiti} crediti restituiti a ${result.ex_proprietario}`,
            liberazione: result
        });

    } catch (error) {
        console.error('Errore liberazione giocatore:', error);
        
        if (error.message.includes('non trovato') || 
            error.message.includes('non assegnato')) {
            return res.status(400).json({ error: error.message });
        }
        
        res.status(500).json({ error: 'Errore interno del server' });
    }
});
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedExtensions = ['.xlsx', '.xls'];
        const fileExtension = path.extname(file.originalname).toLowerCase();
        
        if (allowedExtensions.includes(fileExtension)) {
            cb(null, true);
        } else {
            cb(new Error('Formato file non supportato. Usa solo .xlsx o .xls'), false);
        }
    }
});

// POST /api/admin/process-excel - Processa file Excel e mostra preview
router.post('/process-excel', upload.single('excel'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nessun file caricato' });
        }

        console.log(`📁 Processing Excel file: ${req.file.originalname} (${req.file.size} bytes)`);

        // Leggi il file Excel dalla memoria
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        
        // Prendi il primo sheet
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        // Converti in JSON
        const rawData = xlsx.utils.sheet_to_json(sheet, { 
            header: 1, // Usa array invece di oggetti
            defval: '' // Valore default per celle vuote
        });

        if (rawData.length < 2) {
            return res.status(400).json({ 
                error: 'File Excel vuoto o senza dati validi' 
            });
        }

        // Processa i dati (salta la prima riga se contiene header)
        const processedData = [];
        const errors = [];

        // Inizia dalla riga 1 (o 0 se non hai header)
        for (let i = 1; i < rawData.length; i++) {
            const row = rawData[i];
            
            // Salta righe vuote
            if (!row || row.length === 0 || !row[0]) continue;

            try {
                const player = {
                    id: row[0] ? parseInt(row[0]) : null,           // Colonna A: ID
                    ruolo: row[1] ? row[1].toString().trim() : '',  // Colonna B: Ruolo
                    nome: row[3] ? row[3].toString().trim() : '',   // Colonna D: Nome
                    squadra: row[4] ? row[4].toString().trim() : '', // Colonna E: Squadra
                    quotazione: row[5] ? parseInt(row[5]) : 0       // Colonna F: Quotazione
                };

                // Validazioni base
                if (!player.id || isNaN(player.id)) {
                    errors.push(`Riga ${i + 1}: ID non valido (${row[0]})`);
                    continue;
                }

                if (!['P', 'D', 'C', 'A'].includes(player.ruolo)) {
                    errors.push(`Riga ${i + 1}: Ruolo non valido (${player.ruolo}). Deve essere P, D, C o A`);
                    continue;
                }

                if (!player.nome) {
                    errors.push(`Riga ${i + 1}: Nome calciatore mancante`);
                    continue;
                }

                if (!player.squadra) {
                    errors.push(`Riga ${i + 1}: Squadra mancante`);
                    continue;
                }

                if (!player.quotazione || player.quotazione <= 0) {
                    errors.push(`Riga ${i + 1}: Quotazione non valida (${row[5]})`);
                    continue;
                }

                processedData.push(player);

            } catch (error) {
                errors.push(`Riga ${i + 1}: Errore nel processamento - ${error.message}`);
            }
        }

        // Se ci sono troppi errori, ferma tutto
        if (errors.length > 0 && errors.length > processedData.length * 0.1) {
            console.error('Troppi errori nel file Excel:', errors);
            return res.status(400).json({ 
                error: 'Troppi errori nel file Excel',
                errori: errors.slice(0, 10), // Mostra solo i primi 10 errori
                totale_errori: errors.length
            });
        }

        console.log(`✅ Processati ${processedData.length} calciatori, ${errors.length} errori`);

        res.json({
            message: 'File processato con successo',
            preview: processedData.slice(0, 50), // Mostra solo i primi 50 per performance
            total: processedData.length,
            errori: errors.length > 0 ? errors : undefined,
            file_info: {
                nome: req.file.originalname,
                dimensione: req.file.size,
                righe_processate: processedData.length
            }
        });

    } catch (error) {
        console.error('Errore processing Excel:', error);
        
        if (error.message.includes('Formato file non supportato')) {
            return res.status(400).json({ error: error.message });
        }
        
        res.status(500).json({ 
            error: 'Errore nel processamento del file Excel',
            dettagli: error.message 
        });
    }
});

// POST /api/admin/update-calciatori - Aggiorna database con dati Excel
router.post('/update-calciatori', upload.single('excel'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Nessun file caricato' });
        }

        console.log(`🔄 Aggiornamento database con file: ${req.file.originalname}`);

        // Prima verifica la struttura della tabella
        try {
            const checkColumns = await query(`
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = 'calciatori'
            `);
            console.log('📊 Colonne tabella calciatori:', checkColumns.rows.map(r => r.column_name));
        } catch (e) {
            console.log('⚠️ Non riesco a verificare le colonne della tabella');
        }

        // Riprocessa il file
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawData = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

        console.log(`📊 Righe totali nel file: ${rawData.length}`);

        if (rawData.length < 2) {
            return res.status(400).json({ error: 'File Excel vuoto o senza dati validi' });
        }

        const processedData = [];
        let righeScartate = 0;
        const erroriValidazione = [];

        for (let i = 1; i < rawData.length; i++) {
            const row = rawData[i];
            if (!row || row.length === 0 || !row[0]) {
                righeScartate++;
                continue;
            }

            const player = {
                id: parseInt(row[0]),
                ruolo: row[1] ? row[1].toString().trim().toUpperCase() : '',
                nome: row[3] ? row[3].toString().trim() : '',
                squadra: row[4] ? row[4].toString().trim() : '',
                quotazione: parseInt(row[5]) || 0
            };

            // Debug delle prime righe
            if (i <= 5) {
                console.log(`🔍 Riga ${i}:`, {
                    raw: row.slice(0, 6),
                    processed: player
                });
            }

            // Validazioni dettagliate
            const validationErrors = [];
            
            if (!player.id || isNaN(player.id)) {
                validationErrors.push(`ID non valido: ${row[0]}`);
            }
            
            if (!['P', 'D', 'C', 'A'].includes(player.ruolo)) {
                validationErrors.push(`Ruolo non valido: ${player.ruolo}`);
            }
            
            if (!player.nome || player.nome.length < 2) {
                validationErrors.push(`Nome non valido: ${player.nome}`);
            }
            
            if (!player.squadra || player.squadra.length < 2) {
                validationErrors.push(`Squadra non valida: ${player.squadra}`);
            }
            
            if (!player.quotazione || player.quotazione <= 0) {
                validationErrors.push(`Quotazione non valida: ${row[5]}`);
            }

            if (validationErrors.length === 0) {
                processedData.push(player);
            } else {
                righeScartate++;
                if (erroriValidazione.length < 10) {
                    erroriValidazione.push({
                        riga: i + 1,
                        errori: validationErrors,
                        dati: player
                    });
                }
            }
        }

        console.log(`📊 Processamento completato: ${processedData.length} validi, ${righeScartate} scartati`);

        if (processedData.length === 0) {
            return res.status(400).json({ 
                error: 'Nessun dato valido trovato nel file',
                errori_validazione: erroriValidazione
            });
        }

        console.log(`🎯 Primi 3 calciatori validi:`, processedData.slice(0, 3));

        // Statistiche iniziali
        const statsBefore = await query(`
            SELECT 
                COUNT(*) as totale,
                COUNT(CASE WHEN is_disponibile = true THEN 1 END) as disponibili,
                COUNT(CASE WHEN is_disponibile = false THEN 1 END) as assegnati
            FROM calciatori
        `);
        
        console.log(`📊 Stato database PRIMA: ${statsBefore.rows[0].totale} totali, ${statsBefore.rows[0].disponibili} disponibili, ${statsBefore.rows[0].assegnati} assegnati`);

        let aggiornati = 0;
        let aggiunti = 0;
        let eliminati = 0;
        const errori = [];
        const dettagliAggiornamenti = [];

        console.log(`🏁 Inizio aggiornamento database per ${processedData.length} calciatori`);

        // FASE 1: Aggiorna/Aggiungi calciatori dal file
        for (const player of processedData) {
            try {
                // Verifica se il calciatore esiste già
                const esistente = await query(
                    'SELECT id, nome, squadra, ruolo, quotazione FROM calciatori WHERE id = $1',
                    [player.id]
                );

                if (esistente.rows.length > 0) {
                    const vecchio = esistente.rows[0];
                    
                    // Controlla se ci sono effettivamente cambiamenti
                    const hasChanges = 
                        vecchio.nome !== player.nome ||
                        vecchio.squadra !== player.squadra ||
                        vecchio.ruolo !== player.ruolo ||
                        vecchio.quotazione !== player.quotazione;

                    if (hasChanges) {
                        // Aggiorna calciatore esistente SENZA updated_at
                        await query(`
                            UPDATE calciatori 
                            SET nome = $1, squadra = $2, ruolo = $3, quotazione = $4
                            WHERE id = $5
                        `, [player.nome, player.squadra, player.ruolo, player.quotazione, player.id]);
                        
                        aggiornati++;
                        
                        if (dettagliAggiornamenti.length < 10) {
                            dettagliAggiornamenti.push({
                                tipo: 'UPDATE',
                                id: player.id,
                                nome: player.nome,
                                cambiamenti: {
                                    nome: vecchio.nome !== player.nome ? `${vecchio.nome} → ${player.nome}` : null,
                                    squadra: vecchio.squadra !== player.squadra ? `${vecchio.squadra} → ${player.squadra}` : null,
                                    ruolo: vecchio.ruolo !== player.ruolo ? `${vecchio.ruolo} → ${player.ruolo}` : null,
                                    quotazione: vecchio.quotazione !== player.quotazione ? `${vecchio.quotazione} → ${player.quotazione}` : null,
                                }
                            });
                        }
                        
                        console.log(`✅ AGGIORNATO: ${player.nome} (ID: ${player.id}) - Cambiamenti: ${JSON.stringify({
                            nome: vecchio.nome !== player.nome,
                            squadra: vecchio.squadra !== player.squadra,
                            ruolo: vecchio.ruolo !== player.ruolo,
                            quotazione: vecchio.quotazione !== player.quotazione
                        })}`);
                    } else {
                        console.log(`⏭️ SKIP: ${player.nome} (ID: ${player.id}) - Nessun cambiamento`);
                    }
                } else {
                    // Inserisci nuovo calciatore SENZA created_at e updated_at
                    await query(`
                        INSERT INTO calciatori (id, nome, squadra, ruolo, quotazione, is_disponibile)
                        VALUES ($1, $2, $3, $4, $5, true)
                    `, [player.id, player.nome, player.squadra, player.ruolo, player.quotazione]);
                    
                    aggiunti++;
                    
                    if (dettagliAggiornamenti.length < 10) {
                        dettagliAggiornamenti.push({
                            tipo: 'INSERT',
                            id: player.id,
                            nome: player.nome,
                            squadra: player.squadra,
                            ruolo: player.ruolo,
                            quotazione: player.quotazione
                        });
                    }
                    
                    console.log(`✅ AGGIUNTO: ${player.nome} (ID: ${player.id})`);
                }
            } catch (error) {
                console.error(`❌ Errore aggiornamento calciatore ${player.id} (${player.nome}):`, error.message);
                errori.push({
                    id: player.id,
                    nome: player.nome,
                    errore: error.message
                });
            }
        }

        console.log(`🎯 Fase 1 completata: ${aggiornati} aggiornati, ${aggiunti} aggiunti, ${errori.length} errori`);

        // FASE 2: Elimina calciatori NON ASSEGNATI che non sono nel nuovo file
        const idsNelFile = processedData.map(player => player.id);
        
        console.log(`🔍 Totale IDs nel file: ${idsNelFile.length}`);
        console.log(`🔍 Primi 10 IDs nel file:`, idsNelFile.slice(0, 10));

        if (idsNelFile.length > 0) {
            try {
                // Prima ottieni la lista dei calciatori da eliminare per log
                const daEliminare = await query(`
                    SELECT id, nome, squadra 
                    FROM calciatori 
                    WHERE id NOT IN (${idsNelFile.map((_, i) => `$${i + 1}`).join(',')})
                    AND is_disponibile = true
                    AND id NOT IN (
                        SELECT DISTINCT calciatore_id 
                        FROM rose 
                        WHERE calciatore_id IS NOT NULL
                    )
                    LIMIT 20
                `, idsNelFile);

                if (daEliminare.rows.length > 0) {
                    console.log(`🔍 Calciatori che saranno eliminati (${daEliminare.rows.length}):`, 
                        daEliminare.rows.map(c => `${c.nome} (ID: ${c.id})`));

                    // Elimina i calciatori non presenti nel file e non assegnati
                    const deleteResult = await query(`
                        DELETE FROM calciatori 
                        WHERE id NOT IN (${idsNelFile.map((_, i) => `$${i + 1}`).join(',')})
                        AND is_disponibile = true
                        AND id NOT IN (
                            SELECT DISTINCT calciatore_id 
                            FROM rose 
                            WHERE calciatore_id IS NOT NULL
                        )
                        RETURNING id, nome
                    `, idsNelFile);
                    
                    eliminati = deleteResult.rowCount;
                    
                    if (deleteResult.rows.length > 0 && dettagliAggiornamenti.length < 20) {
                        deleteResult.rows.slice(0, 5).forEach(deleted => {
                            dettagliAggiornamenti.push({
                                tipo: 'DELETE',
                                id: deleted.id,
                                nome: deleted.nome
                            });
                        });
                    }
                    
                    console.log(`🗑️ Eliminati ${eliminati} calciatori non più disponibili`);
                } else {
                    console.log(`ℹ️ Nessun calciatore da eliminare`);
                }
                
            } catch (deleteError) {
                console.error('❌ Errore eliminazione calciatori:', deleteError);
                eliminati = 0;
            }
        }

        // Statistiche finali
        const statsAfter = await query(`
            SELECT 
                COUNT(*) as totale,
                COUNT(CASE WHEN is_disponibile = true THEN 1 END) as disponibili,
                COUNT(CASE WHEN is_disponibile = false THEN 1 END) as assegnati
            FROM calciatori
        `);
        
        console.log(`📊 Stato database DOPO: ${statsAfter.rows[0].totale} totali, ${statsAfter.rows[0].disponibili} disponibili, ${statsAfter.rows[0].assegnati} assegnati`);

        // Verifica integrità finale
        const verificaIntegrita = await query(`
            SELECT 
                COUNT(DISTINCT c.id) as calciatori_totali,
                COUNT(DISTINCT r.calciatore_id) as calciatori_assegnati,
                COUNT(DISTINCT CASE WHEN c.is_disponibile = true THEN c.id END) as calciatori_disponibili
            FROM calciatori c
            LEFT JOIN rose r ON c.id = r.calciatore_id
        `);

        console.log(`🏆 RISULTATO FINALE: ${aggiornati} aggiornati, ${aggiunti} aggiunti, ${eliminati} eliminati, ${errori.length} errori`);

        // Mostra un esempio di calciatori aggiornati per verifica
        if (aggiornati > 0 || aggiunti > 0) {
            const esempiCalciatori = await query(`
                SELECT id, nome, squadra, ruolo, quotazione 
                FROM calciatori 
                WHERE id IN (${processedData.slice(0, 5).map(p => p.id).join(',')})
            `);
            console.log('📋 Esempio calciatori dopo aggiornamento:', esempiCalciatori.rows);
        }

        res.json({
            message: aggiornati > 0 || aggiunti > 0 || eliminati > 0 ? 
                'Database aggiornato con successo' : 
                'Nessun aggiornamento necessario - i dati sono già aggiornati',
            risultato: {
                aggiornati: aggiornati,
                aggiunti: aggiunti,
                eliminati: eliminati,
                totale_processati: processedData.length,
                righe_scartate: righeScartate,
                errori_totali: errori.length
            },
            statistiche: {
                prima: statsBefore.rows[0],
                dopo: statsAfter.rows[0],
                integrita: verificaIntegrita.rows[0]
            },
            dettagli_aggiornamenti: dettagliAggiornamenti.length > 0 ? dettagliAggiornamenti : undefined,
            errori: errori.length > 0 ? errori.slice(0, 10) : undefined,
            errori_validazione: erroriValidazione.length > 0 ? erroriValidazione : undefined,
            file_info: {
                nome: req.file.originalname,
                dimensione: req.file.size,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('💥 Errore aggiornamento database:', error);
        res.status(500).json({ 
            error: 'Errore nell\'aggiornamento del database',
            dettagli: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Aggiungi anche questa rotta per verificare/creare le colonne mancanti se necessario
router.post('/fix-calciatori-table', requireAdmin, async (req, res) => {
    try {
        // Verifica quali colonne esistono
        const columns = await query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'calciatori'
        `);
        
        const existingColumns = columns.rows.map(r => r.column_name);
        console.log('Colonne esistenti:', existingColumns);
        
        const modifications = [];
        
        // Aggiungi created_at se non esiste
        if (!existingColumns.includes('created_at')) {
            await query(`
                ALTER TABLE calciatori 
                ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            `);
            modifications.push('Aggiunta colonna created_at');
        }
        
        // Aggiungi updated_at se non esiste
        if (!existingColumns.includes('updated_at')) {
            await query(`
                ALTER TABLE calciatori 
                ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            `);
            modifications.push('Aggiunta colonna updated_at');
        }
        
        res.json({
            message: modifications.length > 0 ? 'Tabella aggiornata' : 'Tabella già corretta',
            modifications: modifications,
            columns: existingColumns
        });
        
    } catch (error) {
        console.error('Errore fix tabella:', error);
        res.status(500).json({ 
            error: 'Errore nel fix della tabella',
            dettagli: error.message 
        });
    }
});

// GET /api/admin/backup-calciatori - Backup dei calciatori prima di aggiornamenti
router.get('/backup-calciatori', async (req, res) => {
    try {
        const result = await query(`
            SELECT id, nome, squadra, ruolo, quotazione, is_disponibile, 
                   created_at, updated_at
            FROM calciatori 
            ORDER BY id
        `);

        res.json({
            message: 'Backup calciatori generato',
            timestamp: new Date().toISOString(),
            totale: result.rows.length,
            calciatori: result.rows
        });

    } catch (error) {
        console.error('Errore generazione backup:', error);
        res.status(500).json({ error: 'Errore nella generazione del backup' });
    }
});


module.exports = router;