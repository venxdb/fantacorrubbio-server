const express = require('express');
const { query, transaction } = require('../config/database');
const { authenticateToken, requireAdmin, checkAdvancedCredits, getRuoloNome } = require('../middleware/auth'); // ✅ AGGIORNATO import
const { chiudiAstaSingola } = require('../utils/scheduler');
const router = express.Router();

// GET /api/aste - Lista tutte le aste
router.get('/', async (req, res) => {
    try {
        const { stato, limit = 20, offset = 0 } = req.query;

        let sqlQuery = `
            SELECT a.*, 
                   c.nome as calciatore_nome, c.squadra, c.ruolo, c.quotazione,
                   u.username as vincitore_username,
                   COUNT(o.id) as numero_offerte,
                   MAX(o.importo) as offerta_massima
            FROM aste a
            JOIN calciatori c ON a.calciatore_id = c.id
            LEFT JOIN utenti u ON a.vincitore_id = u.id
            LEFT JOIN offerte o ON a.id = o.asta_id
            WHERE 1=1
        `;

        const params = [];
        let paramCount = 0;

        if (stato) {
            paramCount++;
            sqlQuery += ` AND a.stato = $${paramCount}`;
            params.push(stato);
        }

        sqlQuery += `
            GROUP BY a.id, c.nome, c.squadra, c.ruolo, c.quotazione, u.username
            ORDER BY a.created_at DESC
            LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
        `;
        params.push(parseInt(limit), parseInt(offset));

        const result = await query(sqlQuery, params);

        res.json({
            aste: result.rows,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset)
            }
        });

    } catch (error) {
        console.error('Errore recupero aste:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/aste/:id - Dettagli singola asta
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Recupero asta con dettagli calciatore
        const astaResult = await query(`
            SELECT a.*, 
                   c.nome as calciatore_nome, c.squadra, c.ruolo, c.quotazione,
                   u.username as vincitore_username
            FROM aste a
            JOIN calciatori c ON a.calciatore_id = c.id
            LEFT JOIN utenti u ON a.vincitore_id = u.id
            WHERE a.id = $1
        `, [id]);

        if (astaResult.rows.length === 0) {
            return res.status(404).json({ error: 'Asta non trovata' });
        }

        // Recupero tutte le offerte per questa asta
        const offerteResult = await query(`
            SELECT o.*, u.username
            FROM offerte o
            JOIN utenti u ON o.utente_id = u.id
            WHERE o.asta_id = $1
            ORDER BY o.importo DESC, o.created_at ASC
        `, [id]);

        const asta = astaResult.rows[0];
        
        res.json({
            ...asta,
            offerte: offerteResult.rows,
            numero_offerte: offerteResult.rows.length,
            offerta_massima: offerteResult.rows.length > 0 ? offerteResult.rows[0].importo : 0
        });

    } catch (error) {
        console.error('Errore recupero asta:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// POST /api/aste - Crea nuova asta (solo admin)
router.post('/', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { calciatore_id, durata_minuti = 2 } = req.body;

        if (!calciatore_id) {
            return res.status(400).json({ error: 'ID calciatore richiesto' });
        }

        // Verifica che il calciatore esista e sia disponibile
        const calciatoreResult = await query(`
            SELECT c.*, r.utente_id as proprietario_id
            FROM calciatori c
            LEFT JOIN rose r ON c.id = r.calciatore_id
            WHERE c.id = $1
        `, [calciatore_id]);

        if (calciatoreResult.rows.length === 0) {
            return res.status(404).json({ error: 'Calciatore non trovato' });
        }

        const calciatore = calciatoreResult.rows[0];
        
        if (calciatore.proprietario_id) {
            return res.status(400).json({ error: 'Calciatore già acquistato' });
        }

        // Verifica che non ci sia già un'asta attiva per questo calciatore
        const astaAttivaResult = await query(`
            SELECT id FROM aste 
            WHERE calciatore_id = $1 AND stato IN ('in_attesa', 'attiva')
        `, [calciatore_id]);

        if (astaAttivaResult.rows.length > 0) {
            return res.status(400).json({ error: 'Asta già attiva per questo calciatore' });
        }

        // Calcola tempo fine
        const tempoFine = new Date();
        tempoFine.setMinutes(tempoFine.getMinutes() + parseInt(durata_minuti));

        // Crea l'asta
        const result = await query(`
            INSERT INTO aste (calciatore_id, stato, tempo_fine)
            VALUES ($1, 'attiva', $2)
            RETURNING *
        `, [calciatore_id, tempoFine]);

        const nuovaAsta = result.rows[0];

        console.log(`🏛️ Admin ${req.user.username} ha creato asta per ${calciatore.nome} (${calciatore.ruolo}) - durata ${durata_minuti}min`);

        res.status(201).json({
            message: 'Asta creata con successo',
            asta: {
                ...nuovaAsta,
                calciatore_nome: calciatore.nome,
                squadra: calciatore.squadra,
                ruolo: calciatore.ruolo,
                quotazione: calciatore.quotazione
            }
        });

    } catch (error) {
        console.error('Errore creazione asta:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// Aggiungi questi log di debug nella route POST /:id/offerta per capire dove si blocca:

router.post('/:id/offerta', authenticateToken, checkAdvancedCredits, async (req, res) => {
    try {
        const { id: astaId } = req.params;
        const { importo } = req.body;
        const utenteId = req.user.id;

        console.log('🔍 DEBUG INIZIO:', { astaId, importo, utenteId, tipo: typeof importo });

        const parsedImporto = parseInt(importo);
        if (isNaN(parsedImporto) || parsedImporto < 0) {
            console.log('❌ DEBUG: Parsing fallito', { importo, parsedImporto });
            return res.status(400).json({ 
                error: 'Importo non valido (minimo 0 per bluffare)' 
            });
        }

        console.log('✅ DEBUG: Parsing OK', { parsedImporto });

        // I controlli avanzati sono già stati fatti nel middleware checkAdvancedCredits
        const { creditiUsabili, ruoloCalciatore, nomeCalciatore, conteggioRuoli } = req.validationInfo;

        console.log('🔍 DEBUG: Validation info', { 
            creditiUsabili, 
            ruoloCalciatore, 
            nomeCalciatore, 
            hasValidationInfo: !!req.validationInfo 
        });

        await transaction(async (client) => {
            console.log('🔍 DEBUG: Inizio transazione');

            // Verifica che l'asta esista e sia attiva
            const astaResult = await client.query(`
                SELECT a.*, c.nome as calciatore_nome, c.ruolo
                FROM aste a
                JOIN calciatori c ON a.calciatore_id = c.id
                WHERE a.id = $1
            `, [astaId]);

            console.log('🔍 DEBUG: Query asta completata', { 
                found: astaResult.rows.length > 0,
                astaId 
            });

            if (astaResult.rows.length === 0) {
                throw new Error('Asta non trovata');
            }

            const asta = astaResult.rows[0];

            console.log('🔍 DEBUG: Asta trovata', { 
                stato: asta.stato, 
                tempo_fine: asta.tempo_fine,
                now: new Date()
            });

            if (asta.stato !== 'attiva') {
                throw new Error('Asta non attiva');
            }

            if (new Date() > new Date(asta.tempo_fine)) {
                throw new Error('Asta scaduta');
            }

            console.log('🔍 DEBUG: Prima della query INSERT/UPDATE', { 
                astaId, 
                utenteId, 
                parsedImporto,
                tipoImporto: typeof parsedImporto
            });

            // Inserisce o aggiorna l'offerta (UPSERT)
            await client.query(`
                INSERT INTO offerte (asta_id, utente_id, importo)
                VALUES ($1, $2, $3)
                ON CONFLICT (asta_id, utente_id)
                DO UPDATE SET 
                    importo = EXCLUDED.importo,
                    created_at = CURRENT_TIMESTAMP
            `, [astaId, utenteId, parsedImporto]);

            console.log('✅ DEBUG: Query INSERT/UPDATE completata');

            return { success: true };
        });

        console.log('✅ DEBUG: Transazione completata con successo');

        // Log dettagliato per monitoraggio
        console.log(`💰 ${req.user.username} offre ${parsedImporto} per ${nomeCalciatore} (${ruoloCalciatore}) - Tipo: ${parsedImporto === 0 ? 'BLUFF' : 'OFFERTA'} - Crediti usabili: ${creditiUsabili}`);

        res.json({
            message: parsedImporto === 0 ? 'Bluff registrato con successo! 🎭' : 'Offerta registrata con successo',
            importo: parsedImporto,
            asta_id: astaId,
            info_crediti: {
                crediti_usabili: creditiUsabili,
                crediti_riservati: req.validationInfo.creditiRiservati,
                giocatori_mancanti: req.validationInfo.giocatoriMancanti
            },
            calciatore: {
                nome: nomeCalciatore,
                ruolo: ruoloCalciatore,
                nome_ruolo: getRuoloNome(ruoloCalciatore)
            }
        });

    } catch (error) {
        console.error('💥 ERRORE COMPLETO registrazione offerta:', error);
        console.error('💥 STACK TRACE:', error.stack);
        console.error('💥 PARAMETRI:', { 
            astaId: req.params.id, 
            importo: req.body.importo, 
            utenteId: req.user?.id,
            hasValidationInfo: !!req.validationInfo 
        });
        
        if (error.message === 'Asta non trovata') {
            return res.status(404).json({ error: error.message });
        }
        if (['Asta non attiva', 'Asta scaduta'].includes(error.message)) {
            return res.status(400).json({ error: error.message });
        }
        
        res.status(500).json({ 
            error: 'Errore interno del server',
            details: error.message // ✅ Aggiungi dettagli per debug
        });
    }
});

// POST /api/aste/:id/chiudi - Chiudi asta e assegna calciatore (solo admin)
router.post('/:id/chiudi', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id: astaId } = req.params;

        const risultato = await chiudiAstaSingola(parseInt(astaId));

        console.log(`👤 Admin ${req.user.username} ha chiuso manualmente l'asta ${astaId}`);

        res.json(risultato);

    } catch (error) {
        console.error('Errore chiusura manuale asta:', error);
        
        if (error.message === 'Asta non trovata o non attiva') {
            return res.status(404).json({ error: error.message });
        }
        
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/aste/attive/current - Asta attualmente attiva
router.get('/attive/current', async (req, res) => {
    try {
        const result = await query(`
            SELECT a.*, 
                   c.nome as calciatore_nome, c.squadra, c.ruolo, c.quotazione,
                   COUNT(o.id) as numero_offerte,
                   MAX(o.importo) as offerta_massima
            FROM aste a
            JOIN calciatori c ON a.calciatore_id = c.id
            LEFT JOIN offerte o ON a.id = o.asta_id
            WHERE a.stato = 'attiva' AND a.tempo_fine > NOW()
            GROUP BY a.id, c.nome, c.squadra, c.ruolo, c.quotazione
            ORDER BY a.created_at ASC
            LIMIT 1
        `);

        if (result.rows.length === 0) {
            return res.json({ asta: null, message: 'Nessuna asta attiva al momento' });
        }

        res.json({ asta: result.rows[0] });

    } catch (error) {
        console.error('Errore recupero asta attiva:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// ✅ NUOVO: GET /api/aste/user/rosa-info - Info dettagliate rosa utente
router.get('/user/rosa-info', authenticateToken, async (req, res) => {
    try {
        const utenteId = req.user.id;

        // Conta giocatori per ruolo
        const rosaResult = await query(`
            SELECT 
                c.ruolo,
                COUNT(*) as count,
                COALESCE(SUM(r.prezzo_acquisto), 0) as spesa_totale,
                ARRAY_AGG(
                    json_build_object(
                        'nome', c.nome,
                        'squadra', c.squadra,
                        'quotazione', c.quotazione,
                        'prezzo_acquisto', r.prezzo_acquisto
                    ) ORDER BY r.prezzo_acquisto DESC
                ) as giocatori
            FROM rose r
            JOIN calciatori c ON r.calciatore_id = c.id
            WHERE r.utente_id = $1
            GROUP BY c.ruolo
        `, [utenteId]);

        const LIMITI_RUOLI = {
            'P': { max: 3, nome: 'Portieri' },
            'D': { max: 8, nome: 'Difensori' },
            'C': { max: 8, nome: 'Centrocampisti' },
            'A': { max: 6, nome: 'Attaccanti' }
        };

        // Prepara risposta strutturata
        const rosaInfo = {};
        let giocatoriTotali = 0;
        let spesaTotale = 0;

        // Inizializza tutti i ruoli
        Object.keys(LIMITI_RUOLI).forEach(ruolo => {
            rosaInfo[ruolo] = {
                nome: LIMITI_RUOLI[ruolo].nome,
                attuali: 0,
                massimo: LIMITI_RUOLI[ruolo].max,
                mancanti: LIMITI_RUOLI[ruolo].max,
                completo: false,
                spesa: 0,
                giocatori: []
            };
        });

        // Popola con dati reali
        rosaResult.rows.forEach(row => {
            const ruolo = row.ruolo;
            const count = parseInt(row.count);
            
            rosaInfo[ruolo] = {
                ...rosaInfo[ruolo],
                attuali: count,
                mancanti: LIMITI_RUOLI[ruolo].max - count,
                completo: count >= LIMITI_RUOLI[ruolo].max,
                spesa: parseInt(row.spesa_totale),
                giocatori: row.giocatori || []
            };
            
            giocatoriTotali += count;
            spesaTotale += parseInt(row.spesa_totale);
        });

        const giocatoriMancanti = 25 - giocatoriTotali;
        const creditiDisponibili = req.user.crediti_totali - spesaTotale;
        const creditiRiservati = Math.max(0, giocatoriMancanti - 1);
        const creditiUsabili = Math.max(0, creditiDisponibili - creditiRiservati);

        res.json({
            rosa: rosaInfo,
            riepilogo: {
                giocatori_totali: giocatoriTotali,
                giocatori_mancanti: giocatoriMancanti,
                spesa_totale: spesaTotale,
                crediti_totali: req.user.crediti_totali,
                crediti_disponibili: creditiDisponibili,
                crediti_riservati: creditiRiservati,
                crediti_usabili: creditiUsabili,
                rosa_completa: giocatoriTotali === 25
            }
        });

    } catch (error) {
        console.error('Errore info rosa:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// ✅ NUOVO: GET /api/aste/user/validation-info/:astaId - Info validazione per specifica asta
router.get('/user/validation-info/:astaId', authenticateToken, async (req, res) => {
    try {
        const { astaId } = req.params;
        const utenteId = req.user.id;

        // Recupera info asta e calciatore
        const astaResult = await query(`
            SELECT a.*, c.ruolo, c.nome as calciatore_nome, c.squadra, c.quotazione
            FROM aste a
            JOIN calciatori c ON a.calciatore_id = c.id
            WHERE a.id = $1 AND a.stato = 'attiva'
        `, [astaId]);

        if (astaResult.rows.length === 0) {
            return res.status(404).json({ error: 'Asta non trovata o non attiva' });
        }

        const asta = astaResult.rows[0];

        // Conta giocatori attuali per ruolo
        const rosaResult = await query(`
            SELECT c.ruolo, COUNT(*) as count
            FROM rose r
            JOIN calciatori c ON r.calciatore_id = c.id
            WHERE r.utente_id = $1
            GROUP BY c.ruolo
        `, [utenteId]);

        const conteggioRuoli = { 'P': 0, 'D': 0, 'C': 0, 'A': 0 };
        rosaResult.rows.forEach(row => {
            conteggioRuoli[row.ruolo] = parseInt(row.count);
        });

        const LIMITI_RUOLI = {
            'P': { max: 3 }, 'D': { max: 8 }, 'C': { max: 8 }, 'A': { max: 6 }
        };

        // Calcola info validazione
        const giocatoriAttuali = Object.values(conteggioRuoli).reduce((sum, count) => sum + count, 0);
        const giocatoriMancanti = 25 - giocatoriAttuali;
        const creditiDisponibili = req.user.crediti_totali - (req.user.crediti_spesi || 0);
        const creditiRiservati = Math.max(0, giocatoriMancanti - 1);
        const creditiUsabili = Math.max(0, creditiDisponibili - creditiRiservati);
        
        const ruoloCompleto = conteggioRuoli[asta.ruolo] >= LIMITI_RUOLI[asta.ruolo].max;

        res.json({
            asta: {
                id: asta.id,
                calciatore_nome: asta.calciatore_nome,
                squadra: asta.squadra,
                ruolo: asta.ruolo,
                nome_ruolo: getRuoloNome(asta.ruolo),
                quotazione: asta.quotazione
            },
            validazione: {
                puo_offrire: !ruoloCompleto,
                ruolo_completo: ruoloCompleto,
                crediti_usabili: creditiUsabili,
                crediti_riservati: creditiRiservati,
                motivo_blocco: ruoloCompleto ? 
                    `Reparto ${getRuoloNome(asta.ruolo)} completo (${conteggioRuoli[asta.ruolo]}/${LIMITI_RUOLI[asta.ruolo].max})` : 
                    null
            },
            rosa_status: {
                giocatori_attuali: giocatoriAttuali,
                giocatori_mancanti: giocatoriMancanti,
                dettaglio: {
                    portieri: `${conteggioRuoli.P}/${LIMITI_RUOLI.P.max}`,
                    difensori: `${conteggioRuoli.D}/${LIMITI_RUOLI.D.max}`,
                    centrocampisti: `${conteggioRuoli.C}/${LIMITI_RUOLI.C.max}`,
                    attaccanti: `${conteggioRuoli.A}/${LIMITI_RUOLI.A.max}`
                }
            }
        });

    } catch (error) {
        console.error('Errore info validazione:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// DELETE /api/aste/delete-all - Elimina tutte le aste (solo admin)
router.delete('/delete-all', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await transaction(async (client) => {
            console.log(`🗑️ Admin ${req.user.username} sta eliminando tutte le aste...`);

            // Prima conta quante aste ci sono
            const countResult = await client.query('SELECT COUNT(*) as count FROM aste');
            const totalAste = parseInt(countResult.rows[0].count);

            if (totalAste === 0) {
                throw new Error('Nessuna asta da eliminare');
            }

            // Elimina prima tutte le offerte associate alle aste
            const deleteOfferteResult = await client.query(`
                DELETE FROM offerte 
                WHERE asta_id IN (SELECT id FROM aste)
            `);

            // Poi elimina tutte le aste
            await client.query('DELETE FROM aste');

            console.log(`✅ Eliminate ${totalAste} aste e ${deleteOfferteResult.rowCount} offerte associate`);

            return {
                aste_eliminate: totalAste,
                offerte_eliminate: deleteOfferteResult.rowCount
            };
        });

        res.json({
            message: 'Tutte le aste sono state eliminate con successo',
            dettagli: result
        });

    } catch (error) {
        console.error('Errore eliminazione tutte le aste:', error);
        
        if (error.message === 'Nessuna asta da eliminare') {
            return res.status(400).json({ 
                error: error.message,
                count: 0 
            });
        }
        
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

module.exports = router;