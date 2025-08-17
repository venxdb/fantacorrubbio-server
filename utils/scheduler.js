const { query, transaction } = require('../config/database');

// Funzione per chiudere automaticamente le aste scadute
const chiudiAsteScadute = async () => {
    try {
        console.log('🕒 Controllo aste scadute...');

        const asteScadute = await query(`
            SELECT id, calciatore_id, tempo_fine
            FROM aste 
            WHERE stato = 'attiva' AND tempo_fine <= NOW()
        `);

        if (asteScadute.rows.length === 0) {
            console.log('✅ Nessuna asta scaduta');
            return;
        }

        console.log(`📋 Trovate ${asteScadute.rows.length} aste scadute`);

        // Processa ogni asta scaduta
        for (const asta of asteScadute.rows) {
            try {
                await chiudiAstaSingola(asta.id);
                console.log(`✅ Asta ${asta.id} chiusa automaticamente`);
            } catch (error) {
                console.error(`❌ Errore chiusura asta ${asta.id}:`, error.message);
            }
        }

    } catch (error) {
        console.error('❌ Errore controllo aste scadute:', error);
    }
};

// 🔧 CORREZIONE: Chiude una singola asta con gestione pareggi corretta
const chiudiAstaSingola = async (astaId) => {
    return await transaction(async (client) => {
        // Recupera asta con dettagli calciatore
        const astaResult = await client.query(`
            SELECT a.*, c.nome as calciatore_nome, c.squadra, c.ruolo
            FROM aste a
            JOIN calciatori c ON a.calciatore_id = c.id
            WHERE a.id = $1 AND a.stato = 'attiva'
        `, [astaId]);

        if (astaResult.rows.length === 0) {
            throw new Error('Asta non trovata o non attiva');
        }

        const asta = astaResult.rows[0];

        // 🔍 CORREZIONE: Recupera TUTTE le offerte per analizzare i pareggi
        const tuteOfferteResult = await client.query(`
            SELECT o.*, u.username
            FROM offerte o
            JOIN utenti u ON o.utente_id = u.id
            WHERE o.asta_id = $1 AND o.importo > 0
            ORDER BY o.importo DESC, o.created_at ASC
        `, [astaId]);

        if (tuteOfferteResult.rows.length === 0) {
            // Nessuna offerta - asta senza vincitore
            await client.query(`
                UPDATE aste 
                SET stato = 'chiusa'
                WHERE id = $1
            `, [astaId]);

            console.log(`📝 Asta ${astaId} (${asta.calciatore_nome}) chiusa senza offerte`);
            return { 
                success: true, 
                vincitore: null, 
                prezzo: 0,
                pareggio: false,
                messaggio: 'Asta chiusa senza offerte'
            };
        }

        const offerte = tuteOfferteResult.rows;
        const offertaMigliore = offerte[0];
        
        // 🎯 CONTROLLO PAREGGI: Verifica se ci sono più offerte con lo stesso importo massimo
        const offerteAlMassimo = offerte.filter(o => o.importo === offertaMigliore.importo);
        
        if (offerteAlMassimo.length > 1) {
            // 🤝 PAREGGIO RILEVATO - Non assegnare automaticamente
            console.log(`⚖️ PAREGGIO rilevato nell'asta ${astaId} (${asta.calciatore_nome}):`, 
                offerteAlMassimo.map(o => `${o.username}: ${o.importo}`).join(', '));

            // Chiudi l'asta senza vincitore (richiede intervento manuale)
            await client.query(`
                UPDATE aste 
                SET stato = 'chiusa', prezzo_finale = $1
                WHERE id = $2
            `, [offertaMigliore.importo, astaId]);

            console.log(`🤝 Asta ${astaId} (${asta.calciatore_nome}) chiusa con pareggio - ASSEGNAZIONE MANUALE RICHIESTA`);

            return {
                success: true,
                vincitore: null,
                prezzo: offertaMigliore.importo,
                pareggio: true,
                partecipantiPareggio: offerteAlMassimo.map(o => o.username),
                numeroPartecipanti: offerteAlMassimo.length,
                calciatore: asta.calciatore_nome,
                messaggio: `Pareggio a ${offertaMigliore.importo} crediti tra ${offerteAlMassimo.length} partecipanti. Assegnazione manuale richiesta.`
            };
        }

        // 🏆 VINCITORE CHIARO - Procedi con assegnazione automatica
        const offertaVincente = offertaMigliore;

        // Aggiorna l'asta con vincitore e prezzo finale
        await client.query(`
            UPDATE aste 
            SET stato = 'chiusa', vincitore_id = $1, prezzo_finale = $2
            WHERE id = $3
        `, [offertaVincente.utente_id, offertaVincente.importo, astaId]);

        // Aggiungi calciatore alla rosa del vincitore
        await client.query(`
            INSERT INTO rose (utente_id, calciatore_id, prezzo_acquisto)
            VALUES ($1, $2, $3)
        `, [offertaVincente.utente_id, asta.calciatore_id, offertaVincente.importo]);

        // Aggiorna crediti spesi del vincitore
        await client.query(`
            UPDATE utenti 
            SET crediti_spesi = crediti_spesi + $1
            WHERE id = $2
        `, [offertaVincente.importo, offertaVincente.utente_id]);

        // Marca calciatore come non disponibile
        await client.query(`
            UPDATE calciatori 
            SET is_disponibile = false
            WHERE id = $1
        `, [asta.calciatore_id]);

        console.log(`🏆 ${asta.calciatore_nome} assegnato a ${offertaVincente.username} per ${offertaVincente.importo} crediti`);

        return {
            success: true,
            vincitore: offertaVincente.username,
            prezzo: offertaVincente.importo,
            pareggio: false,
            calciatore: asta.calciatore_nome,
            messaggio: `${asta.calciatore_nome} assegnato a ${offertaVincente.username} per ${offertaVincente.importo} crediti`
        };
    });
};

// Avvia il controllo periodico delle aste scadute
const avviaScheduler = () => {
    console.log('⏰ Scheduler aste avviato (controllo ogni 30 secondi)');
    
    // Controllo immediato all'avvio
    chiudiAsteScadute();
    
    // Controllo ogni 30 secondi
    setInterval(chiudiAsteScadute, 30000);
};

// Funzione per ottenere statistiche scheduler
const getSchedulerStats = async () => {
    try {
        const stats = await query(`
            SELECT 
                COUNT(CASE WHEN stato = 'attiva' THEN 1 END) as aste_attive,
                COUNT(CASE WHEN stato = 'chiusa' AND vincitore_id IS NOT NULL THEN 1 END) as aste_concluse,
                COUNT(CASE WHEN stato = 'chiusa' AND vincitore_id IS NULL THEN 1 END) as aste_senza_vincitore,
                COUNT(CASE WHEN stato = 'attiva' AND tempo_fine <= NOW() THEN 1 END) as aste_scadute_da_chiudere
            FROM aste
        `);

        return stats.rows[0];
    } catch (error) {
        console.error('Errore recupero statistiche scheduler:', error);
        return null;
    }
};

module.exports = {
    avviaScheduler,
    chiudiAsteScadute,
    chiudiAstaSingola,
    getSchedulerStats
};