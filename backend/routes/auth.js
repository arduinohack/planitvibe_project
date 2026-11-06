const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');  // For password hashing
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Invitation = require('../models/Invitation');
const AllowedEmail = require('../models/AllowedEmail');
const logger = require('../utils/logger');  // Added: Borrow exported logger from ../util/logger.js
const authMiddleware = require('../middleware/auth.js');  // Add this line for token verification
const { v4: uuidv4 } = require('uuid');  // For reset token
const { sendEmail, selectedProviderName } = require('../utils/email/sendEmail');
const { sendSms } = require('../utils/sms');
const {
  issueSession,
  signAccessToken,
  rotateRefresh,
  deleteRefresh,
  revokeSessionRefresh,
} = require('../utils/sessionTokens');
const {
  registerLimiter,
  loginLimiter,
  forgotPasswordLimiter,
  resendVerificationLimiter,
} = require('../middleware/authRateLimit');
const {
  INVALID_LINK,
  ALREADY_VERIFIED,
  VERIFICATION_SENT,
  hashVerifyToken,
  buildVerification,
  mustVerifyEmail,
  sendVerificationEmail,
} = require('../utils/emailVerification');
const { checkTurnstile } = require('../utils/turnstile');

const INVITE_REQUEST_EMAIL = 'ken@eratespecialists.com';
const INVITE_REQUEST_SMS = '+14044081476';

function noteSupportAccount(req, { actorUserId, actorEmail } = {}) {
  const noted = {};
  if (actorUserId) noted.actorUserId = String(actorUserId);
  if (typeof actorEmail === 'string' && actorEmail.trim()) noted.actorEmail = actorEmail.trim();
  req.supportAccount = noted;
}

function submittedEmail(body) {
  if (!body || typeof body.email !== 'string') return '';
  return body.email.trim();
}

// POST /api/auth/login (Verifies email/password, returns token)
router.post('/login', loginLimiter, async (req, res) => {
  // This initial request for login does not use middleware
  const userId = req.user?.id ?? 'User ID not in request';
  const { email, password } = req.body;
  const emailForLog = submittedEmail(req.body);
  logger.info('Login Request', {
    userId: userId,
    event: 'AuthLogin',
    context: { email: email }
  });
 
  // Validate required fields
  if (!email || !password) {
    noteSupportAccount(req, { actorEmail: emailForLog });
    logger.error('Missing required fields: email, password', {
      userId: userId,
      event: 'AuthLogin',
      context: { email: email }
    });
    return res.status(400).json({ message: 'Missing required fields: email, password' });
  }

  try {
    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      noteSupportAccount(req, { actorEmail: emailForLog });
      logger.error('User Not Found', {
        userId: userId,
        event: 'AuthLogin',
        context: { email: email }
      });
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Verify password (compare hashed)
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      noteSupportAccount(req, { actorUserId: user._id, actorEmail: user.email || emailForLog });
      logger.error('Password mismatch - invalid credentials', {
        userId: userId,
        event: 'AuthLogin',
        context: { email: email }
      });
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Access JWT stays { userId, role }. Refresh is an opaque Redis token.
    const { token, refreshToken } = await issueSession(user, { includeRole: true });

    // Return token and user without password
    const userWithoutPassword = user.toObject();  // Convert to plain object
    delete userWithoutPassword.password;  // Hide password
    noteSupportAccount(req, { actorUserId: user._id, actorEmail: user.email });
    res.status(200).json({ token, refreshToken, user: userWithoutPassword });
    logger.info('Login successful', {
      userId: user._id,
      event: 'AuthLogin',
      context: { email: email }
    });
  } catch (error) {
      logger.error('Server error', {
        userId: userId,
        event: 'AuthLogin',
        context: { error: error }  // Sanitize sensitive data!
      });
      res.status(500).json({ message: 'Server error' });
  }
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isRequestEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// POST /api/auth/register (Creates new user, hashes password, returns token)
// A new account requires a pending invitation for that email.
router.post('/register', registerLimiter, async (req, res) => {
  const userId = req.user?.id ?? 'User ID not in request';
  const { firstName, lastName, email, phoneNumber, password, address } = req.body;
  logger.info('Registration Request', {
    userId: userId,
    event: 'AuthRegister',
    context: { email: email }
  });

  const turnstile = await checkTurnstile(req.body && req.body.turnstileToken, req.ip);
  if (!turnstile.ok) {
    if (turnstile.error) {
      logger.error('Turnstile siteverify failed', {
        userId: userId,
        event: 'AuthRegister',
        context: { error: turnstile.error },
      });
    }
    return res.status(turnstile.status).json({ message: turnstile.message });
  }

  // Validate required fields
  if (!firstName || !lastName || !email || !password) {
    logger.error('Missing required fields: firstName, lastName, email, password', {
      userId: userId,
      event: 'AuthRegister',
      context: { firstName: firstName, lastName: lastName, email: email, password: password }  // Sanitize sensitive data!
    });
    return res.status(400).json({ msg: 'Missing required fields: firstName, lastName, email, password' });
  }
  
  if (address && (!address.city || !address.country)) {
    logger.error('Invalid address - city and country required', {
      userId: userId,
      event: 'AuthRegister',
      context: { city: address.city, country: address.country }  // Sanitize sensitive data!
    });
    return res.status(400).json({ msg: 'Invalid address—city and country required' });
  }

  try {
    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      logger.info('User already exists with this email', {
        userId: userId,
        event: 'AuthRegister',
        context: { email: email }  // Sanitize sensitive data!
      });
      return res.status(400).json({ msg: 'User already exists with this email' });
    }

    const inviteEmail = normalizeEmail(email);
    const allowedEmail = await AllowedEmail.findOne({ email: inviteEmail }).select('_id');
    if (!allowedEmail) {
      return res.status(403).json({
        error: 'This email is not yet invited to join PlanItVibe.',
      });
    }

    const pendingInvite = await Invitation.findOne({
      status: 'pending',
      email: { $regex: `^${escapeRegex(inviteEmail)}$`, $options: 'i' },
    }).select('_id');
    if (!pendingInvite) {
      return res.status(403).json({ msg: 'Signup is by invitation.' });
    }

    // Create user (UUID for _id). User pre-save hashes the password once.
    const newUserId = uuidv4();
    const verifyNow = mustVerifyEmail();
    const issued = verifyNow ? buildVerification() : null;
    const newUser = new User({
      _id: newUserId,
      firstName,
      lastName,
      email,
      phoneNumber,
      password,
      address: address || undefined, // Use if provided
      notificationPreferences: { email: true, sms: false },  // Default
      role: 'member',
      emailVerified: verifyNow ? false : true,
      emailVerifyToken: issued ? issued.hash : undefined,
      emailVerifyExpires: issued ? issued.expires : undefined,
    });
    logger.info('Saving new user', {
      userId: newUserId,
      event: 'AuthRegister',
      context: { email: email }
    });
    await newUser.save();

    if (issued) {
      try {
        await sendVerificationEmail(newUser.email, issued.raw);
      } catch (err) {
        const status = (err.response && err.response.statusCode) || err.statusCode;
        const provider = err.provider || selectedProviderName();
        logger.error(`Verification email failed: provider ${provider}: ${err.message}${status ? ` status ${status}` : ''}`, {
          userId: newUserId,
          event: 'AuthRegister',
          context: { email, provider, status: status || undefined },
        });
      }
    }

    await Invitation.updateMany(
      {
        status: 'pending',
        email: { $regex: `^${escapeRegex(inviteEmail)}$`, $options: 'i' },
        $or: [{ userId: { $exists: false } }, { userId: null }, { userId: '' }],
      },
      { $set: { userId: newUserId } },
    );

    const savedUser = await User.findById(newUserId).select('-password');
    const { token, refreshToken } = await issueSession(
      { _id: newUserId, role: savedUser ? savedUser.role : 'member' },
      { includeRole: false },
    );
    const userWithoutPassword = savedUser ? savedUser.toObject() : { _id: newUserId };
    delete userWithoutPassword.password;

    logger.info('Generated new token and sent to newly registered user', {
      userId: newUserId,
      event: 'AuthRegister',
      context: { email: email }
    });
    res.status(201).json({
      msg: 'User registered successfully!',
      token,
      refreshToken,
      user: userWithoutPassword,
    });
  } catch (err) {
      logger.error('Server error', {
        userId: userId,
        event: 'AuthPWReset',
        context: { error: err }  // Sanitize sensitive data!
      });
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/auth/request-invite
// An existing account is reported and not notified. A new request emails and
// texts the operator only. It does not create a user or an invitation.
router.post('/request-invite', async (req, res) => {
  const userId = req.user?.id ?? 'User ID not in request';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';

  if (!name) {
    logger.error('Invitation request name is missing', {
      userId: userId,
      event: 'AuthRequestInvite',
      context: { email }
    });
    return res.status(400).json({ msg: 'Name is required' });
  }

  if (!isRequestEmail(email)) {
    logger.error('Invitation request email is not valid', {
      userId: userId,
      event: 'AuthRequestInvite',
      context: { email }
    });
    return res.status(400).json({ msg: 'Email is not valid' });
  }

  const existingUser = await User.findOne({
    email: { $regex: `^${escapeRegex(normalizeEmail(email))}$`, $options: 'i' },
  }).select('_id');
  if (existingUser) {
    return res.status(200).json({ exists: true });
  }

  const message = `PlanItVibe: ${name} requested an invitation. Email: ${email}`;
  const smsBody = `PlanItVibe invitation request: ${name}`;
  logger.info('Invitation request', {
    userId: userId,
    event: 'AuthRequestInvite',
    context: { email }
  });

  try {
    const result = await sendEmail({
      to: INVITE_REQUEST_EMAIL,
      subject: 'PlanItVibe invitation request',
      text: message,
      html: `<p>${escapeHtml(message)}</p>`,
    });
    logger.info('Invitation request email sent', {
      userId: userId,
      event: 'AuthRequestInvite',
      context: {
        email,
        to: INVITE_REQUEST_EMAIL,
        result: result == null ? 'sent' : result,
      }
    });
  } catch (err) {
    const status = (err.response && err.response.statusCode) || err.statusCode;
    const provider = err.provider || selectedProviderName();
    logger.error('Invitation request email failed', {
      userId: userId,
      event: 'AuthRequestInvite',
      context: {
        email,
        to: INVITE_REQUEST_EMAIL,
        result: 'failed',
        provider,
        status: status || undefined,
        error: err.message,
      }
    });
  }

  try {
    await sendSms({ to: INVITE_REQUEST_SMS, body: smsBody });
  } catch (err) {
    logger.error('Invitation request SMS failed', {
      userId: userId,
      event: 'AuthRequestInvite',
      context: { email, error: err.message }
    });
  }

  res.status(200).json({ exists: false });
});

// POST /api/auth/forgot-password (Sends reset email with token)
router.post('/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const userId = req.user?.id ?? 'User ID not in request';
  const { email } = req.body;

  if (!email) {
    logger.error('Missing email', {
      userId: userId,
      event: 'AuthForgotPWRequest',
      context: { email: email }
    });
    return res.status(400).json({ msg: 'Missing email' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      logger.error('User Not Found', {
        userId: userId,
        event: 'AuthForgotPWRequest',
        context: { email: email }  // Sanitize sensitive data!
      });
      // Security: Don't reveal if email exists
      return res.json({ msg: 'If the email exists, a reset link has been sent' });
    }

    // Generate reset token (UUID) and expiry (1h)
    const resetToken = uuidv4();
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);  // 1 hour from now

    // Save to user
    user.resetToken = resetToken;
    user.resetTokenExpiry = resetTokenExpiry;
    logger.info('Saving PW Reset Token for user', {
      userId: userId,
      event: 'AuthForgotPWRequest',
      context: { email: email }
    });
    await user.save();

    // Account email only. sendEmail applies EMAIL_PROVIDER and the shared From.
    // Do not use NOTIFY_OVERRIDE_EMAIL or the development Gmail override.
    const accountEmail = user.email;
    const resetUrl = `http://localhost:3000/reset-password?token=${resetToken}&email=${accountEmail}`;
    logger.info('Requesting password reset email to user', {
      userId: userId,
      event: 'AuthForgotPWRequest',
      context: { email: accountEmail }
    });
    try {
      await sendEmail({
        to: accountEmail,
        subject: 'PlanItVibe password reset',
        text: `PlanItVibe: reset your password: ${resetUrl}\nThis link expires in 1 hour.`,
        html: `<p>PlanItVibe: reset your password: <a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p>`
      });
    } catch (err) {
      const status = (err.response && err.response.statusCode) || err.statusCode;
      const provider = err.provider || selectedProviderName();
      logger.error(`Password reset email failed: provider ${provider}: ${err.message}${status ? ` status ${status}` : ''}`, {
        userId: userId,
        event: 'AuthForgotPWRequest',
        context: { email: email, provider, status: status || undefined }
      });
      return res.status(500).json({ msg: 'Server error' });
    }

    res.json({ msg: 'If the email exists, a reset link has been sent' });
  } catch (err) {
      logger.error('Server error', {
        userId: userId,
        event: 'AuthForgotPWRequest',
        context: { error: err }  // Sanitize sensitive data!
      });
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/auth/verify-email { token }
router.post('/verify-email', async (req, res) => {
  const raw = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!raw) {
    return res.status(400).json({ message: INVALID_LINK });
  }

  try {
    const user = await User.findOne({
      emailVerifyToken: hashVerifyToken(raw),
      emailVerifyExpires: { $gt: new Date() },
    }).select('_id');
    if (!user) {
      return res.status(400).json({ message: INVALID_LINK });
    }

    await User.updateOne(
      { _id: user._id },
      {
        $set: { emailVerified: true },
        $unset: { emailVerifyToken: 1, emailVerifyExpires: 1 },
      },
    );
    return res.status(200).json({ message: 'Email verified.' });
  } catch (err) {
    logger.error('Server error', {
      userId: 'User ID not in request',
      event: 'AuthVerifyEmail',
      context: { error: err.message },
    });
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/resend-verification (JWT). 5 requests / hour / IP.
router.post('/resend-verification', resendVerificationLimiter, authMiddleware, async (req, res) => {
  const callerId = req.user.userId || req.user.id;
  try {
    const user = await User.findById(callerId).select('email emailVerified');
    if (!user) {
      return res.status(401).json({ message: 'Token is not valid' });
    }
    if (user.emailVerified !== false) {
      return res.status(200).json({ message: ALREADY_VERIFIED });
    }
    if (!user.email) {
      return res.status(400).json({ message: 'Missing email' });
    }

    const issued = buildVerification();
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          emailVerified: false,
          emailVerifyToken: issued.hash,
          emailVerifyExpires: issued.expires,
        },
      },
    );

    try {
      await sendVerificationEmail(user.email, issued.raw);
    } catch (err) {
      const status = (err.response && err.response.statusCode) || err.statusCode;
      const provider = err.provider || selectedProviderName();
      logger.error(`Verification email failed: provider ${provider}: ${err.message}${status ? ` status ${status}` : ''}`, {
        userId: callerId,
        event: 'AuthResendVerification',
        context: { email: user.email, provider, status: status || undefined },
      });
      return res.status(500).json({ message: 'Server error' });
    }

    return res.status(200).json({ message: VERIFICATION_SENT });
  } catch (err) {
    logger.error('Server error', {
      userId: callerId,
      event: 'AuthResendVerification',
      context: { error: err.message },
    });
    return res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/reset-password (Resets password with token)
router.post('/reset-password', async (req, res) => {
  const userId = req.user?.id ?? 'User ID not in request';
  const { token, email, newPassword } = req.body;

  if (!token || !email || !newPassword) {
    logger.error('Missing token, email or new password', {
      userId: userId,
      event: 'AuthPWReset',
      context: { email: email }
    });
    return res.status(400).json({ msg: 'Missing token, email, or new password' });
  }

  try {
    const user = await User.findOne({ 
      resetToken: token, 
      resetTokenExpiry: { $gt: new Date() },  // Not expired
      email 
    });

    if (!user) {
      logger.error('Invalid or expired token', {
        userId: userId,
        event: 'AuthPWReset',
        context: { email: email }  // Sanitize sensitive data!
      });
      return res.status(400).json({ msg: 'Invalid or expired token' });
    }

    // Hash new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Update password and clear token
    user.password = hashedPassword;
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    logger.info('Updating password and clearing token for user', {
      userId: userId,
      event: 'AuthPWReset',
      context: { email: email }
    });
    await user.save();

    // Generate new JWT token
    const payload = { userId: user._id };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });

    logger.info('Generated new token and sent to user', {
      userId: user._id,
      event: 'AuthPWReset',
      context: { email: email }
    });
    res.json({ msg: 'Password reset successfully!', token });
  } catch (err) {
      logger.error('Server error', {
        userId: userId,
        event: 'AuthPWReset',
        context: { error: err }  // Sanitize sensitive data!
      });
    res.status(500).json({ msg: 'Server error' });
  }
});

// POST /api/auth/verify-token - Verify token and return user
router.post('/verify-token', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];  // Bearer token from header
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_secret_key');  // Verify token
    const user = await User.findById(decoded.userId || decoded.id).select('-password');  // Fetch user without password
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    res.status(200).json({ user });  // Return user
  } catch (error) {
    console.error('Verify token error:', error);
    res.status(401).json({ message: 'Invalid token' });
  }
  
});

// PATCH /api/auth/users/:userId - Update user fields (auth required)
router.patch('/users/:userId', authMiddleware, async (req, res) => {
  // logger.info('In PATCH /api/auth/users/:userId')
  try {
    const { userId } = req.params;
    const updates = req.body;  // e.g., { firstName: 'New Name', phoneNumber: '+1-555-new', notificationPreferences: { email: false } }
    const updaterId = req.user.userId;  // From JWT

    // logger.info(`Backend received /auth/users: id=${userId}`);
    // logger.info(`Backend received /auth/users: req.body=${updates}`);
    // logger.info(`Backend received /auth/users: req.user.userId=${updaterId}`);

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (updaterId !== user._id && req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Not authorized' });
    }

    // Update all allowed fields (partial merge)
    if (updates.firstName) user.firstName = updates.firstName;
    if (updates.lastName) user.lastName = updates.lastName;
    if (updates.email) user.email = updates.email;
    if (updates.phoneNumber) user.phoneNumber = updates.phoneNumber;
    if (updates.address) user.address = updates.address;
    if (updates.notificationPreferences) user.notificationPreferences = updates.notificationPreferences;

    await user.save();

    // Return updated user without password
    const { password: _, ...userWithoutPassword } = user.toObject();
    // logger.info(`User=${userWithoutPassword}`);
    res.status(200).json({ message: 'User updated', user: userWithoutPassword });
  } catch (error) {
    // logger.error('Update user error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/auth/refresh — public. The access token may already be expired.
router.post('/refresh', async (req, res) => {
  const refreshToken = req.body && typeof req.body.refreshToken === 'string'
    ? req.body.refreshToken.trim()
    : '';
  if (!refreshToken) {
    return res.status(401).json({ message: 'Invalid token' });
  }
  try {
    const rotated = await rotateRefresh(refreshToken);
    if (!rotated) {
      return res.status(401).json({ message: 'Invalid token' });
    }
    const user = await User.findById(rotated.userId).select('-password');
    if (!user) {
      await deleteRefresh(rotated.refreshToken, rotated.userId);
      return res.status(401).json({ message: 'Invalid token' });
    }
    const token = signAccessToken(user, { includeRole: true });
    const userWithoutPassword = user.toObject();
    delete userWithoutPassword.password;
    return res.status(200).json({
      token,
      refreshToken: rotated.refreshToken,
      user: userWithoutPassword,
    });
  } catch (error) {
    logger.error('Server error', {
      userId: 'User ID not in request',
      event: 'AuthRefresh',
      context: { error: error.message },
    });
    return res.status(500).json({ message: 'Server error' });
  }
});

// Logout endpoint: POST /api/auth/logout
router.post('/logout', authMiddleware, async (req, res) => {
  const actorUserId = String((req.user && (req.user.userId || req.user.id)) || '');
  let actorEmail = '';
  if (actorUserId) {
    const account = await User.findById(actorUserId).select('email');
    actorEmail = account && typeof account.email === 'string' ? account.email : '';
  }
  noteSupportAccount(req, { actorUserId, actorEmail });
  logger.info('At Logout', {
    userId: req.user.userId,
    event: 'AuthLogout',
    context: {  }
  });
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (global.redisClient && token) {
      await global.redisClient.set(token, 'blacklisted', { EX: 86400 });  // 24h expiration
      logger.info('Token blacklisted', {
        userId: req.user.userId,
        event: 'AuthLogout',
        context: {}
      });
    } else if (!global.redisClient) {
      logger.info('Blacklist skipped, Redis unavailable', {
        userId: req.user.userId,
        event: 'AuthLogout',
        context: {}
      });
    }
    const presented = req.body && typeof req.body.refreshToken === 'string'
      ? req.body.refreshToken.trim()
      : '';
    await revokeSessionRefresh(actorUserId, presented);
    logger.info('User logged out', {
      userId: req.user.userId,
      event: 'AuthLogout',
      context: {}
    });
    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Server error', {
      userId: req.user ? req.user.userId : 'anonymous',
      event: 'AuthLogout',
      context: { error: error.message }
    });
    res.status(500).json({ error: 'Logout error' });
  }
});

module.exports = router;