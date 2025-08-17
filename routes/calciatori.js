// ✅ MODIFICA SOLO routes/calciatori.js

const express = require('express');
const { query } = require('../config/database');
const router = express.Router();

router.get('/', async (req, res) => {
    try {
        const { 
            ruolo,
            squadra,
            disponibile,
            cerca,
            orderBy = 'quotazione', // ✅ DEFAULT: quotazione per pagina Calciatori
            limit = 1000,
            offset = 0 
        } = req.query;

        let sqlQuery = `
            SELECT c.*, 
                CASE WHEN r.calciatore_id IS NOT NULL THEN false ELSE c.is_disponibile END as disponibile,
                u.username as proprietario
            FROM calciatori c
            LEFT JOIN rose r ON c.id = r.calciatore_id
            LEFT JOIN utenti u ON r.utente_id = u.id
            WHERE 1=1
        `;
        
        const params = [];
        let paramCount = 0;

        // Filtri (stessi di prima)
        if (ruolo) {
            paramCount++;
            sqlQuery += ` AND c.ruolo = $${paramCount}`;
            params.push(ruolo.toUpperCase());
        }

        if (squadra) {
            paramCount++;
            sqlQuery += ` AND LOWER(c.squadra) = LOWER($${paramCount})`;
            params.push(squadra);
        }

        if (disponibile !== undefined) {
            if (disponibile === 'true') {
                sqlQuery += ` AND r.calciatore_id IS NULL AND c.is_disponibile = true`;
            } else {
                sqlQuery += ` AND r.calciatore_id IS NOT NULL`;
            }
        }

        if (cerca) {
            paramCount++;
            sqlQuery += ` AND LOWER(c.nome) LIKE LOWER($${paramCount})`;
            params.push(`%${cerca}%`);
        }

        // ✅ ORDINAMENTO INTELLIGENTE
        let orderClause = '';
        
        switch(orderBy) {
            case 'quotazione':
                orderClause = ` ORDER BY c.quotazione DESC, c.nome ASC`;
                break;
            case 'alfabetico':
                orderClause = ` ORDER BY c.nome ASC`;
                break;
            case 'ruolo':
                orderClause = ` ORDER BY 
                    CASE c.ruolo 
                        WHEN 'P' THEN 1 
                        WHEN 'D' THEN 2 
                        WHEN 'C' THEN 3 
                        WHEN 'A' THEN 4 
                        ELSE 5 
                    END,
                    c.nome ASC`;
                break;
            default:
                // Fallback per quotazione
                orderClause = ` ORDER BY c.quotazione DESC, c.nome ASC`;
        }
        
        sqlQuery += orderClause;
        
        paramCount++;
        sqlQuery += ` LIMIT $${paramCount}`;
        params.push(parseInt(limit));

        paramCount++;
        sqlQuery += ` OFFSET $${paramCount}`;
        params.push(parseInt(offset));

        const result = await query(sqlQuery, params);

        // Count query (stessa logica filtri)
        let countQuery = `SELECT COUNT(*) as total FROM calciatori c LEFT JOIN rose r ON c.id = r.calciatore_id WHERE 1=1`;
        const countParams = [];
        let countParamNum = 0;

        if (ruolo) {
            countParamNum++;
            countQuery += ` AND c.ruolo = $${countParamNum}`;
            countParams.push(ruolo.toUpperCase());
        }
        if (squadra) {
            countParamNum++;
            countQuery += ` AND LOWER(c.squadra) = LOWER($${countParamNum})`;
            countParams.push(squadra);
        }
        if (disponibile !== undefined) {
            if (disponibile === 'true') {
                countQuery += ` AND r.calciatore_id IS NULL AND c.is_disponibile = true`;
            } else {
                countQuery += ` AND r.calciatore_id IS NOT NULL`;
            }
        }
        if (cerca) {
            countParamNum++;
            countQuery += ` AND LOWER(c.nome) LIKE LOWER($${countParamNum})`;
            countParams.push(`%${cerca}%`);
        }

        const countResult = await query(countQuery, countParams);

        res.json({
            calciatori: result.rows,
            total: parseInt(countResult.rows[0].total),
            pagination: {
                total: parseInt(countResult.rows[0].total),
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: parseInt(offset) + parseInt(limit) < parseInt(countResult.rows[0].total)
            }
        });

    } catch (error) {
        console.error('Errore recupero calciatori:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// ✅ AGGIUNTO: Route di ricerca specifica per admin (opzionale ma utile)
router.get('/search', async (req, res) => {
    try {
        const { q, disponibile, limit = 100 } = req.query;
        
        let whereClause = '';
        let params = [];
        let paramCount = 1;

        if (q && q.length >= 2) {
            whereClause += `WHERE (LOWER(c.nome) LIKE $${paramCount} OR LOWER(c.squadra) LIKE $${paramCount})`;
            params.push(`%${q.toLowerCase()}%`);
            paramCount++;
        }

        if (disponibile !== undefined) {
            const connector = whereClause ? ' AND ' : 'WHERE ';
            if (disponibile === 'true') {
                whereClause += `${connector}r.calciatore_id IS NULL AND c.is_disponibile = true`;
            } else {
                whereClause += `${connector}r.calciatore_id IS NOT NULL`;
            }
        }

        const result = await query(`
            SELECT c.*, 
                CASE WHEN r.calciatore_id IS NOT NULL THEN false ELSE c.is_disponibile END as disponibile,
                u.username as proprietario
            FROM calciatori c
            LEFT JOIN rose r ON c.id = r.calciatore_id
            LEFT JOIN utenti u ON r.utente_id = u.id
            ${whereClause}
            ORDER BY 
                CASE c.ruolo 
                    WHEN 'P' THEN 1 
                    WHEN 'D' THEN 2 
                    WHEN 'C' THEN 3 
                    WHEN 'A' THEN 4 
                    ELSE 5 
                END,
                c.nome ASC
            LIMIT $${paramCount}
        `, [...params, parseInt(limit)]);

        res.json({ 
            calciatori: result.rows,
            total: result.rows.length 
        });

    } catch (error) {
        console.error('Errore ricerca calciatori:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/calciatori/:id - Singolo calciatore
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await query(`
            SELECT c.*, 
                CASE WHEN r.calciatore_id IS NOT NULL THEN false ELSE c.is_disponibile END as disponibile,
                u.username as proprietario,
                r.prezzo_acquisto
            FROM calciatori c
            LEFT JOIN rose r ON c.id = r.calciatore_id
            LEFT JOIN utenti u ON r.utente_id = u.id
            WHERE c.id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Calciatore non trovato' });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error('Errore recupero calciatore:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/calciatori/stats/overview - Statistiche generali
router.get('/stats/overview', async (req, res) => {
    try {
        const stats = await query(`
            SELECT 
                COUNT(*) as totale_calciatori,
                COUNT(CASE WHEN r.calciatore_id IS NULL THEN 1 END) as disponibili,
                COUNT(CASE WHEN r.calciatore_id IS NOT NULL THEN 1 END) as acquistati,
                ROUND(AVG(c.quotazione), 2) as quotazione_media
            FROM calciatori c
            LEFT JOIN rose r ON c.id = r.calciatore_id
        `);

        const perRuolo = await query(`
            SELECT 
                c.ruolo,
                COUNT(*) as totale,
                COUNT(CASE WHEN r.calciatore_id IS NULL THEN 1 END) as disponibili,
                ROUND(AVG(c.quotazione), 2) as quotazione_media
            FROM calciatori c
            LEFT JOIN rose r ON c.id = r.calciatore_id
            GROUP BY c.ruolo
            ORDER BY 
                CASE c.ruolo 
                    WHEN 'P' THEN 1 
                    WHEN 'D' THEN 2 
                    WHEN 'C' THEN 3 
                    WHEN 'A' THEN 4 
                    ELSE 5 
                END
        `);

        res.json({
            generale: stats.rows[0],
            per_ruolo: perRuolo.rows
        });

    } catch (error) {
        console.error('Errore stats calciatori:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

module.exports = router;