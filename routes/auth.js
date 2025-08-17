const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../config/database');
const { generateToken, authenticateToken } = require('../middleware/auth');
const router = express.Router();

// POST /api/auth/register - Registrazione nuovo utente
router.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        // Validazione input
        if (!username || !email || !password) {
            return res.status(400).json({ 
                error: 'Username, email e password sono obbligatori' 
            });
        }

        if (password.length < 6) {
            return res.status(400).json({ 
                error: 'La password deve essere di almeno 6 caratteri' 
            });
        }

        // Controllo email valida (regex semplice)
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Email non valida' });
        }

        // Controllo se utente esiste già
        const existingUser = await query(
            'SELECT id FROM utenti WHERE username = $1 OR email = $2',
            [username, email]
        );

        if (existingUser.rows.length > 0) {
            return res.status(409).json({ 
                error: 'Username o email già esistenti' 
            });
        }

        // Hash della password
        const passwordHash = await bcrypt.hash(password, 12);

        // Inserimento nuovo utente
        const result = await query(`
            INSERT INTO utenti (username, email, password_hash, crediti_totali)
            VALUES ($1, $2, $3, $4)
            RETURNING id, username, email, crediti_totali, is_admin, created_at
        `, [username, email, passwordHash, process.env.DEFAULT_CREDITS || 500]);

        const newUser = result.rows[0];

        // Genera token JWT
        const token = generateToken(newUser);

        res.status(201).json({
            message: 'Utente registrato con successo',
            token,
            user: {
                id: newUser.id,
                username: newUser.username,
                email: newUser.email,
                crediti_totali: newUser.crediti_totali,
                crediti_spesi: 0,
                is_admin: newUser.is_admin
            }
        });

    } catch (error) {
        console.error('Errore registrazione:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// POST /api/auth/login - Login utente
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Validazione input
        if (!username || !password) {
            return res.status(400).json({ 
                error: 'Username e password sono obbligatori' 
            });
        }

        // Cerca utente (può fare login con username o email)
        const result = await query(`
            SELECT id, username, email, password_hash, crediti_totali, 
                   crediti_spesi, is_admin
            FROM utenti 
            WHERE username = $1 OR email = $1
        `, [username]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Credenziali non valide' });
        }

        const user = result.rows[0];

        // Verifica password
        const passwordValid = await bcrypt.compare(password, user.password_hash);
        if (!passwordValid) {
            return res.status(401).json({ error: 'Credenziali non valide' });
        }

        // Genera token JWT
        const token = generateToken(user);

        res.json({
            message: 'Login effettuato con successo',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                crediti_totali: user.crediti_totali,
                crediti_spesi: user.crediti_spesi,
                is_admin: user.is_admin
            }
        });

    } catch (error) {
        console.error('Errore login:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// GET /api/auth/me - Informazioni utente corrente
router.get('/me', authenticateToken, async (req, res) => {
    try {
        // req.user è già popolato dal middleware authenticateToken
        res.json({
            user: {
                ...req.user,
                crediti_disponibili: req.user.crediti_totali - req.user.crediti_spesi
            }
        });
    } catch (error) {
        console.error('Errore recupero profilo:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

// POST /api/auth/logout - Logout (lato client cancella token)
router.post('/logout', authenticateToken, (req, res) => {
    res.json({ message: 'Logout effettuato con successo' });
});

// PUT /api/auth/change-password - Cambio password
router.put('/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.id;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ 
                error: 'Password attuale e nuova password sono obbligatorie' 
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({ 
                error: 'La nuova password deve essere di almeno 6 caratteri' 
            });
        }

        // Recupera password hash attuale
        const result = await query(
            'SELECT password_hash FROM utenti WHERE id = $1',
            [userId]
        );

        const user = result.rows[0];
        const passwordValid = await bcrypt.compare(currentPassword, user.password_hash);

        if (!passwordValid) {
            return res.status(401).json({ error: 'Password attuale non corretta' });
        }

        // Hash nuova password
        const newPasswordHash = await bcrypt.hash(newPassword, 12);

        // Aggiorna password
        await query(
            'UPDATE utenti SET password_hash = $1 WHERE id = $2',
            [newPasswordHash, userId]
        );

        res.json({ message: 'Password cambiata con successo' });

    } catch (error) {
        console.error('Errore cambio password:', error);
        res.status(500).json({ error: 'Errore interno del server' });
    }
});

module.exports = router;