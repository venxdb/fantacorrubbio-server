const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

// Funzione helper per generare JWT
const generateToken = (user) => {
    return jwt.sign(
        { 
            userId: user.id, // ✅ Manteniamo userId come nel tuo sistema
            username: user.username,
            isAdmin: user.is_admin 
        },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
    );
};

// Middleware per verificare il token JWT
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({ error: 'Token di accesso richiesto' });
        }

        // Verifica del token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // ✅ Usa userId come nel tuo sistema esistente
        const result = await query(
            'SELECT id, username, email, crediti_totali, crediti_spesi, is_admin FROM utenti WHERE id = $1',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Utente non trovato' });
        }

        req.user = result.rows[0];
        next();

    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(403).json({ error: 'Token non valido' });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(403).json({ error: 'Token scaduto' });
        }
        
        console.error('Errore autenticazione:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
};

// Middleware per verificare i permessi admin
const requireAdmin = (req, res, next) => {
    if (!req.user || !req.user.is_admin) {
        return res.status(403).json({ error: 'Permessi amministratore richiesti' });
    }
    next();
};

// Middleware per verificare crediti sufficienti
const checkCredits = (minCredits) => {
    return (req, res, next) => {
        const creditiDisponibili = req.user.crediti_totali - req.user.crediti_spesi;
        
        if (creditiDisponibili < minCredits) {
            return res.status(400).json({ 
                error: 'Crediti insufficienti',
                creditiDisponibili,
                creditiRichiesti: minCredits
            });
        }
        
        req.creditiDisponibili = creditiDisponibili;
        next();
    };
};

// ✅ Funzione helper per nomi ruoli
const getRuoloNome = (ruolo) => {
    const nomi = {
        'P': 'Portieri',
        'D': 'Difensori',
        'C': 'Centrocampisti',
        'A': 'Attaccanti'
    };
    return nomi[ruolo] || ruolo;
};

// Aggiungi questi log nel middleware checkAdvancedCredits per debug:

const checkAdvancedCredits = async (req, res, next) => {
    try {
        console.log('🔍 MIDDLEWARE DEBUG - INIZIO:', {
            body: req.body,
            params: req.params,
            user: req.user?.username
        });

        const utenteId = req.user.id;
        const { importo } = req.body;
        const { id: astaId } = req.params;

        console.log('🔍 MIDDLEWARE DEBUG - Variabili:', {
            utenteId,
            importo,
            astaId,
            tipoImporto: typeof importo
        });

        // ✅ VALIDAZIONE AGGIORNATA: Permetti 0 per bluff, blocca solo negativi o non definiti
        if (importo === undefined || importo === null || importo < 0) {
            console.log('❌ MIDDLEWARE DEBUG - Validazione fallita:', { importo });
            return res.status(400).json({ error: 'Inserisci un importo valido (minimo 0 per bluffare)' });
        }

        const parsedImporto = parseInt(importo);
        if (isNaN(parsedImporto) || parsedImporto < 0) {
            console.log('❌ MIDDLEWARE DEBUG - Parsing fallito:', { importo, parsedImporto });
            return res.status(400).json({ error: 'Inserisci un importo numerico valido (minimo 0)' });
        }

        console.log('✅ MIDDLEWARE DEBUG - Validazione OK:', { parsedImporto });

        // 1. Recupera info asta e ruolo calciatore
        console.log('🔍 MIDDLEWARE DEBUG - Query asta...');
        const astaResult = await query(`
            SELECT a.*, c.ruolo, c.nome as calciatore_nome
            FROM aste a
            JOIN calciatori c ON a.calciatore_id = c.id
            WHERE a.id = $1
        `, [astaId]);

        console.log('🔍 MIDDLEWARE DEBUG - Risultato query asta:', {
            found: astaResult.rows.length > 0,
            astaId
        });

        if (astaResult.rows.length === 0) {
            console.log('❌ MIDDLEWARE DEBUG - Asta non trovata');
            return res.status(404).json({ error: 'Asta non trovata' });
        }

        const { ruolo: ruoloCalciatore, nome: nomeCalciatore } = astaResult.rows[0];

        console.log('🔍 MIDDLEWARE DEBUG - Asta trovata:', { ruoloCalciatore, nomeCalciatore });

        // 2. Conta giocatori attuali per ruolo dell'utente
        console.log('🔍 MIDDLEWARE DEBUG - Query rosa...');
        const rosaAttualeResult = await query(`
            SELECT 
                c.ruolo,
                COUNT(*) as count
            FROM rose r
            JOIN calciatori c ON r.calciatore_id = c.id
            WHERE r.utente_id = $1
            GROUP BY c.ruolo
        `, [utenteId]);

        console.log('🔍 MIDDLEWARE DEBUG - Risultato query rosa:', {
            rows: rosaAttualeResult.rows.length
        });

        // Mappa conteggi attuali
        const conteggioRuoli = {
            'P': 0, 'D': 0, 'C': 0, 'A': 0
        };
        
        rosaAttualeResult.rows.forEach(row => {
            conteggioRuoli[row.ruolo] = parseInt(row.count);
        });

        console.log('🔍 MIDDLEWARE DEBUG - Conteggio ruoli:', conteggioRuoli);

        // 3. Definisci limiti e obiettivi
        const LIMITI_RUOLI = {
            'P': { max: 3, min: 3 },
            'D': { max: 8, min: 8 },
            'C': { max: 8, min: 8 },
            'A': { max: 6, min: 6 }
        };

        const TOTALE_GIOCATORI = 25;

        // 4. Verifica se può ancora acquistare questo ruolo
        if (conteggioRuoli[ruoloCalciatore] >= LIMITI_RUOLI[ruoloCalciatore].max) {
            console.log('❌ MIDDLEWARE DEBUG - Ruolo completo:', {
                ruolo: ruoloCalciatore,
                attuali: conteggioRuoli[ruoloCalciatore],
                max: LIMITI_RUOLI[ruoloCalciatore].max
            });
            return res.status(400).json({ 
                error: `Hai già completato il reparto ${getRuoloNome(ruoloCalciatore)} (${conteggioRuoli[ruoloCalciatore]}/${LIMITI_RUOLI[ruoloCalciatore].max})`,
                ruolo_completo: true,
                dettaglio: {
                    ruolo: ruoloCalciatore,
                    attuali: conteggioRuoli[ruoloCalciatore],
                    massimo: LIMITI_RUOLI[ruoloCalciatore].max,
                    nome_ruolo: getRuoloNome(ruoloCalciatore)
                }
            });
        }

        console.log('✅ MIDDLEWARE DEBUG - Ruolo OK');

        // 5. Calcola giocatori totali attuali
        const giocatoriAttuali = Object.values(conteggioRuoli).reduce((sum, count) => sum + count, 0);
        const giocatoriMancanti = TOTALE_GIOCATORI - giocatoriAttuali;

        // 6. Calcola crediti che devono rimanere per i giocatori obbligatori
        const creditiRiservati = Math.max(0, giocatoriMancanti - 1);

        // 7. Calcola crediti effettivamente disponibili
        const creditiTotaliDisponibili = req.user.crediti_totali - (req.user.crediti_spesi || 0);
        const creditiUsabili = creditiTotaliDisponibili - creditiRiservati;

        console.log('🔍 MIDDLEWARE DEBUG - Calcoli crediti:', {
            giocatoriAttuali,
            giocatoriMancanti,
            creditiTotaliDisponibili,
            creditiRiservati,
            creditiUsabili,
            parsedImporto
        });

        // 8. ✅ CONTROLLO CREDITI AGGIORNATO: Solo per offerte > 0 (permetti bluff a 0)
        if (parsedImporto > 0 && parsedImporto > creditiUsabili) {
            console.log('❌ MIDDLEWARE DEBUG - Crediti insufficienti:', {
                offerta: parsedImporto,
                creditiUsabili
            });
            return res.status(400).json({ 
                error: giocatoriMancanti > 1 ? 
                    `Crediti insufficienti. Devi riservare ${creditiRiservati} crediti per i ${giocatoriMancanti - 1} giocatori rimanenti.` :
                    `Crediti insufficienti. Disponibili: ${creditiUsabili}`,
                crediti_info: {
                    crediti_totali: req.user.crediti_totali,
                    crediti_spesi: req.user.crediti_spesi || 0,
                    crediti_disponibili: creditiTotaliDisponibili,
                    crediti_riservati: creditiRiservati,
                    crediti_usabili: Math.max(0, creditiUsabili),
                    importo_richiesto: parsedImporto
                }
            });
        }

        console.log('✅ MIDDLEWARE DEBUG - Crediti OK');

        // 9. Aggiungi info al request per uso nelle route successive
        req.validationInfo = {
            creditiUsabili: Math.max(0, creditiUsabili),
            creditiRiservati,
            giocatoriMancanti,
            conteggioRuoli,
            ruoloCalciatore,
            nomeCalciatore,
            limitiRuoli: LIMITI_RUOLI
        };

        console.log('✅ MIDDLEWARE DEBUG - ValidationInfo impostato:', req.validationInfo);

        // 10. ✅ LOG AGGIORNATO: Distingui bluff da offerte reali
        console.log(`🔍 Validazione ${req.user.username}:`, {
            calciatore: nomeCalciatore,
            ruolo: ruoloCalciatore,
            offerta: parsedImporto,
            tipo: parsedImporto === 0 ? 'BLUFF' : 'OFFERTA',
            creditiUsabili: Math.max(0, creditiUsabili),
            giocatoriMancanti
        });

        console.log('✅ MIDDLEWARE DEBUG - FINE, chiamando next()');
        next();

    } catch (error) {
        console.error('💥 MIDDLEWARE ERROR:', error);
        console.error('💥 MIDDLEWARE STACK:', error.stack);
        res.status(500).json({ error: 'Errore interno del server nel middleware' });
    }
};

module.exports = {
    authenticateToken,
    requireAdmin,
    checkCredits,
    generateToken,
    checkAdvancedCredits, // ✅ Supporta offerte a 0 per bluff
    getRuoloNome
};