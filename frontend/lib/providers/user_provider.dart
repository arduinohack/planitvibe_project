import 'package:flutter/foundation.dart'; // For ChangeNotifier
import 'package:http/http.dart' as http;
import 'dart:convert';
import '../api/api_client.dart' as api;
import '../biometric_unlock.dart';
import '../session_bridge.dart';
import '../session_refresh.dart';
import '../utils/logger.dart';
import '../config/constants.dart'; // Add this line for backendBaseUrl
import '../models/plan_access.dart';
import '../models/user.dart'; // Your User model with Address/Preferences
import '../config/config.dart';
import '../storage/token_store.dart';
import '../utils/itinerary_cache_binding.dart';
import '../utils/jwt_expiry.dart';

enum SessionKeep { stay, login, idle }

class AuthRateLimitException implements Exception {
  AuthRateLimitException(this.message);
  final String message;
}

class UserProvider extends ChangeNotifier {
  String? currentUserId; // Current user ID
  UserRole? _currentUserRole; // Private stub role
  User? _currentUser; // Private full user object
  String? _jwtToken; // Stored token
  PlanAccess? _planAccess;
  int _sessionEpoch = 0;
  bool _biometricEntry = false;
  bool _biometricDeclined = false;
  bool _coldStartSettled = false;

  UserProvider() {
    onSessionRefreshed = (access) {
      _jwtToken = access;
      notifyListeners();
    };
    onSessionEnded = _handleSessionEnded;
    if (!mobileBiometricPlatform) _coldStartSettled = true;
  }

  void _handleSessionEnded() {
    _sessionEpoch++;
    _jwtToken = null;
    currentUserId = null;
    _currentUserRole = null;
    _currentUser = null;
    _planAccess = null;
    _biometricEntry = false;
    notifyListeners();
  }

  UserRole? get currentUserRole => _currentUserRole;
  User? get currentUser => _currentUser;
  String? get token => _jwtToken;
  PlanAccess? get planAccess => _planAccess;

  Future<void> loadPlanAccess() async {
    final token = _jwtToken;
    if (token == null || token.isEmpty) return;
    try {
      final response = await api.get(
        Uri.parse('$backendBaseUrl$apiUserAiCredits'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode != 200) return;
      final data = json.decode(response.body);
      if (data is! Map) return;
      _planAccess = PlanAccess.fromJson(Map<String, dynamic>.from(data));
      notifyListeners();
    } catch (e) {
      logger.e('Plan access load error: $e');
    }
  }

  bool get hasSession {
    final saved = _jwtToken;
    if (saved != null && saved.isNotEmpty) return true;
    return currentUserId != null || _currentUser != null;
  }

  bool get biometricDeclined => _biometricDeclined;

  /// False until the mobile cold-start prompt has finished. Web and desktop
  /// start settled so session resume is unchanged.
  bool get coldStartSettled => _coldStartSettled;

  /// False only when the server says this account has not verified email.
  bool get needsEmailVerification => _currentUser?.emailVerified == false;

  void noteAppResumed() {
    _biometricDeclined = false;
  }

  /// True once, after a biometric unlock that should open the app.
  bool consumeBiometricEntry() {
    if (!_biometricEntry) return false;
    _biometricEntry = false;
    return true;
  }

  Map<String, dynamic> _jsonObject(String body) {
    final decoded = json.decode(body);
    if (decoded is Map) return Map<String, dynamic>.from(decoded);
    return <String, dynamic>{};
  }

  String _errorText(Object error) {
    final text = error.toString();
    const prefix = 'Exception: ';
    if (text.startsWith(prefix)) return text.substring(prefix.length);
    return text;
  }

  String? _jsonMessage(http.Response response) {
    try {
      final decoded = json.decode(response.body);
      if (decoded is Map) {
        final message = decoded['message'] ?? decoded['msg'];
        if (message != null) {
          final text = message.toString().trim();
          if (text.isNotEmpty) return text;
        }
      }
    } catch (_) {}
    return null;
  }

  String _signupFailureMessage(http.Response response) {
    return _jsonMessage(response) ?? 'Signup failed: ${response.statusCode}';
  }

  String _loginFailureMessage(http.Response response) {
    return _jsonMessage(response) ?? 'Login failed: ${response.statusCode}';
  }

  // Login with real backend (POST /api/auth/login).
  // Returns null on success. A missing required value returns its name
  // and does not throw.
  Future<String?> login(String email, String password) async {
    try {
      final timeoutDuration = Duration(seconds: await AppConfig.timeoutSeconds);

      logger.i('Flutter sending login: email=$email, password=$password');
      logger.i(
        'Flutter sending login: email=$email, password=$password',
      ); // Log input
      final response = await http
          .post(
            Uri.parse((backendBaseUrl) + apiAuthLogin),
            headers: {'Content-Type': 'application/json'},
            body: json.encode({'email': email, 'password': password}),
          )
          .timeout(timeoutDuration);

      logger.i('Flutter received status: ${response.statusCode}');
      if (response.statusCode == 200) {
        final data = _jsonObject(response.body);
        final tokenValue = data['token'];
        if (tokenValue is String && tokenValue.isNotEmpty) {
          _sessionEpoch++;
          _biometricDeclined = false;
          try {
            await writeToken(tokenValue);
          } catch (e) {
            logger.e('Token storage error: $e');
          }
          await _storeRefresh(data['refreshToken']);
          final userValue = data['user'];
          final userMap = userValue is Map
              ? Map<String, dynamic>.from(userValue)
              : <String, dynamic>{};
          final user = User.fromJson(userMap);
          _jwtToken = tokenValue;
          currentUserId = user.id;
          _currentUserRole =
              UserRole.vibeCoordinator; // Stub; later from data['user']['role']
          _currentUser = user;
          notifyListeners();
          final preview = tokenValue.length <= 20
              ? tokenValue
              : tokenValue.substring(0, 20);
          logger.i('Logged in as $email with token: $preview...');
          return null;
        }
        return 'token was null';
      }
      return _loginFailureMessage(response);
    } catch (e) {
      logger.e('Login error: $e');
      return _errorText(e);
    }
  }

  // Signup new user (real API POST /api/auth/register)
  Future<void> signup(
    String firstName,
    String lastName,
    String email,
    String password,
    String phoneNumber,
    Map<String, String> address,
    Map<String, bool> notificationPreferences, {
    required String turnstileToken,
  }) async {
    try {
      final timeoutDuration = Duration(seconds: await AppConfig.timeoutSeconds);
      final response = await http
          .post(
            Uri.parse((backendBaseUrl) + apiAuthRegister),
            headers: {'Content-Type': 'application/json'},
            body: json.encode({
              'firstName': firstName,
              'lastName': lastName,
              'email': email,
              'password': password,
              'phoneNumber': phoneNumber,
              'address': address,
              'notificationPreferences': notificationPreferences,
              'turnstileToken': turnstileToken,
            }),
          )
          .timeout(timeoutDuration);

      if (response.statusCode == 201) {
        final data = json.decode(response.body);
        final token = data['token'];
        if (token is String && token.isNotEmpty) {
          _sessionEpoch++;
          _jwtToken = token;
          final userId = _userIdFromJwt(token);
          if (userId != null) currentUserId = userId;
          try {
            await writeToken(token);
          } catch (e) {
            logger.e('Token storage error: $e');
          }
          await _storeRefresh(data['refreshToken']);
          final userValue = data['user'];
          if (userValue is Map) {
            final user = User.fromJson(Map<String, dynamic>.from(userValue));
            _currentUser = user;
            if (user.id.isNotEmpty) currentUserId = user.id;
          }
          notifyListeners();
        }
        logger.i('Signup successful: ${data['msg'] ?? data['message']}');
      } else {
        throw Exception(_signupFailureMessage(response));
      }
    } catch (e) {
      logger.e('Signup error: $e');
      rethrow; // Pass to UI for SnackBar
    }
  }

  Future<void> _storeRefresh(Object? value) async {
    if (value is! String || value.isEmpty) return;
    try {
      await writeRefreshToken(value);
    } catch (e) {
      logger.e('Refresh token storage error: $e');
    }
  }

  Future<http.Response> _postLogout(
    String token,
    String? refresh,
    Duration timeout,
  ) {
    final body = <String, String>{};
    if (refresh != null && refresh.isNotEmpty) {
      body['refreshToken'] = refresh;
    }
    return http
        .post(
          Uri.parse(backendBaseUrl + apiAuthLogout),
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer $token',
          },
          body: json.encode(body),
        )
        .timeout(timeout);
  }

  // POST /api/auth/logout while the bearer token is still saved, then drop it.
  // A failed call still clears the saved tokens and the biometric preference.
  Future<void> logout() async {
    final epoch = ++_sessionEpoch;
    _biometricDeclined = false;
    _biometricEntry = false;
    String? token = _jwtToken != null && _jwtToken!.isNotEmpty
        ? _jwtToken
        : null;
    if (token == null) {
      try {
        token = await readToken();
      } catch (e) {
        logger.e('Logout token read error: $e');
      }
    }
    String? refresh;
    try {
      refresh = await readRefreshToken();
    } catch (e) {
      logger.e('Logout refresh read error: $e');
    }
    if (epoch != _sessionEpoch) return;
    if (token != null &&
        token.isNotEmpty &&
        jwtIsExpired(token, DateTime.now()) &&
        refresh != null &&
        refresh.isNotEmpty) {
      final refreshed = await refreshSession();
      if (epoch != _sessionEpoch) return;
      if (refreshed) {
        token = _jwtToken;
        try {
          refresh = await readRefreshToken();
        } catch (e) {
          logger.e('Logout refresh read error: $e');
        }
      }
    }
    if (token != null && token.isNotEmpty) {
      try {
        final timeoutDuration = Duration(
          seconds: await AppConfig.timeoutSeconds,
        );
        var response = await _postLogout(token, refresh, timeoutDuration);
        if (response.statusCode == 401 &&
            refresh != null &&
            refresh.isNotEmpty) {
          final refreshed = await refreshSession();
          if (epoch != _sessionEpoch) return;
          if (refreshed) {
            token = _jwtToken ?? token;
            try {
              refresh = await readRefreshToken();
            } catch (e) {
              logger.e('Logout refresh read error: $e');
            }
            response = await _postLogout(token, refresh, timeoutDuration);
          }
        }
        if (response.statusCode != 200) {
          logger.i('Backend logout failed: ${response.statusCode}');
        }
      } catch (e) {
        logger.e('Logout API error: $e');
      }
    }

    if (epoch != _sessionEpoch) return;
    await _deleteLocalCredentials();
    if (epoch != _sessionEpoch) return;
    _jwtToken = null;
    currentUserId = null;
    _currentUserRole = null;
    _currentUser = null;
    _planAccess = null;
    notifyListeners();
    logger.i('Logged out—cleared local storage');
  }

  Future<void> _deleteLocalCredentials() async {
    try {
      await deleteToken();
    } catch (e) {
      logger.e('Logout token delete error: $e');
    }
    try {
      await deleteRefreshToken();
    } catch (e) {
      logger.e('Logout refresh delete error: $e');
    }
    try {
      await clearBiometricPreference();
    } catch (e) {
      logger.e('Logout biometric clear error: $e');
    }
    try {
      await itineraryCache.clear();
    } catch (e) {
      logger.e('Logout itinerary cache clear error: $e');
    }
  }

  /// Drops the saved token and in-memory session. Does not call the logout API.
  Future<void> clearExpiredSession() async {
    final epoch = ++_sessionEpoch;
    _jwtToken = null;
    currentUserId = null;
    _currentUserRole = null;
    _currentUser = null;
    _planAccess = null;
    notifyListeners();
    if (epoch != _sessionEpoch) return;
    try {
      await deleteToken();
    } catch (e) {
      logger.e('Expired session token delete error: $e');
    }
    logger.i('Expired session cleared');
  }

  /// Drops the in-memory session. Keeps both stored tokens and the biometric
  /// preference so a cancelled prompt can try again.
  void _forgetUnlockedMemory() {
    _jwtToken = null;
    currentUserId = null;
    _currentUserRole = null;
    _currentUser = null;
    _planAccess = null;
    _biometricEntry = false;
    notifyListeners();
  }

  /// Drops both tokens. Keeps the biometric preference.
  Future<void> _clearStoredSession() async {
    final epoch = ++_sessionEpoch;
    _jwtToken = null;
    currentUserId = null;
    _currentUserRole = null;
    _currentUser = null;
    _planAccess = null;
    _biometricEntry = false;
    notifyListeners();
    if (epoch != _sessionEpoch) return;
    try {
      await deleteToken();
    } catch (e) {
      logger.e('Session token delete error: $e');
    }
    try {
      await deleteRefreshToken();
    } catch (e) {
      logger.e('Session refresh delete error: $e');
    }
  }

  Future<bool> _verifyStored(String token) async {
    try {
      final timeoutDuration = Duration(seconds: await AppConfig.timeoutSeconds);
      final response = await http
          .post(
            Uri.parse(backendBaseUrl + apiAuthVerifyToken),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
          )
          .timeout(timeoutDuration);
      if (response.statusCode != 200) return false;
      final data = json.decode(response.body);
      final userValue = data is Map ? data['user'] : null;
      if (userValue is! Map) return false;
      final userMap = Map<String, dynamic>.from(userValue);
      final id = userMap['_id'];
      currentUserId = id?.toString();
      final role = userMap['role'];
      _currentUserRole = _roleFromString(role is String ? role : '');
      _currentUser = User.fromJson(userMap);
      _jwtToken = token;
      notifyListeners();
      logger.i(
        'Loaded and verified user from backend: ${userMap['firstName']} ($_currentUserRole)',
      );
      return true;
    } catch (e) {
      logger.e('Error verifying stored token: $e');
      return false;
    }
  }

  Future<bool> _restoreAccess() async {
    var access = _jwtToken;
    if (access == null || access.isEmpty) {
      try {
        access = await readToken();
      } catch (e) {
        logger.e('Session token read error: $e');
      }
    }
    if (access != null &&
        access.isNotEmpty &&
        !jwtIsExpired(access, DateTime.now())) {
      _jwtToken = access;
      if (_currentUser == null) {
        return _verifyStored(access);
      }
      return true;
    }
    if (!await refreshTokenPresent()) return false;
    final outcome = await refreshSessionOutcome();
    logger.i('Session refresh result=$outcome');
    if (outcome == RefreshOutcome.unauthorized) {
      await _clearStoredSession();
      return false;
    }
    if (outcome != RefreshOutcome.refreshed) return false;
    final next = _jwtToken;
    if (next == null || next.isEmpty) return false;
    if (_currentUser == null) return _verifyStored(next);
    return true;
  }

  /// When the access token is past its expiry, refresh it. A biometric
  /// gate runs first. Cancel keeps both stored tokens and the preference.
  Future<SessionKeep> keepSessionAlive({required bool promptBiometric}) async {
    final memory = _jwtToken;
    if (memory != null &&
        memory.isNotEmpty &&
        !jwtIsExpired(memory, DateTime.now())) {
      return SessionKeep.stay;
    }
    if (promptBiometric && _biometricDeclined) return SessionKeep.idle;

    final gate = promptBiometric && await shouldGateOnBiometric();
    if (gate) {
      final unlocked = await unlockWithBiometric();
      logger.i('Resume authenticate result=$unlocked');
      if (!unlocked) {
        _biometricDeclined = true;
        _forgetUnlockedMemory();
        return SessionKeep.login;
      }
    } else {
      final hasRefresh = await refreshTokenPresent();
      if (!hasSession && !hasRefresh && (memory == null || memory.isEmpty)) {
        return SessionKeep.idle;
      }
    }

    final restored = await _restoreAccess();
    if (!restored) {
      return SessionKeep.login;
    }
    if (gate) {
      _biometricEntry = true;
      notifyListeners();
    }
    return SessionKeep.stay;
  }

  // Load stored token and verify user (real API POST /api/auth/verify-token).
  // Does not prompt. Mobile cold start prompts in [unlockOnColdStart] first.
  Future<void> loadStoredToken() async {
    final epoch = _sessionEpoch;
    try {
      String? stored;
      try {
        stored = await readToken();
      } catch (e) {
        logger.e('Error loading stored token: $e');
        return;
      }
      if (epoch != _sessionEpoch) return;
      final expired =
          stored == null ||
          stored.isEmpty ||
          jwtIsExpired(stored, DateTime.now());
      if (expired) {
        final hasRefresh = await refreshTokenPresent();
        if (!hasRefresh) {
          if (stored != null && stored.isNotEmpty) {
            await clearExpiredSession();
          } else {
            logger.i('No stored token—user not logged in');
          }
          logger.i('Stored session refresh result=skipped');
          return;
        }
        final outcome = await refreshSessionOutcome();
        logger.i('Stored session refresh result=$outcome');
        if (epoch != _sessionEpoch) return;
        if (outcome == RefreshOutcome.unauthorized) {
          await _clearStoredSession();
          return;
        }
        if (outcome != RefreshOutcome.refreshed) return;
        stored = _jwtToken;
      } else {
        logger.i('Stored session refresh result=skipped');
      }
      if (stored == null || stored.isEmpty) return;
      if (epoch != _sessionEpoch) return;
      final verified = await _verifyStored(stored);
      if (epoch != _sessionEpoch) return;
      if (!verified) {
        logger.i('Token invalid—clearing');
        await logout();
        return;
      }
    } catch (e) {
      if (epoch != _sessionEpoch) return;
      logger.e('Error loading stored token: $e');
      await logout();
    }
  }

  /// Mobile cold start. Reads the biometric flag and the refresh token,
  /// prompts before navigation when both say to, then refreshes. Returns
  /// true when the plan list should open. Cancel keeps the tokens and the flag.
  Future<bool> unlockOnColdStart() async {
    final epoch = _sessionEpoch;
    try {
      final enabled = await biometricEnabled();
      final refreshPresent = await refreshTokenPresent();
      logger.i(
        'Cold start biometric flag=$enabled refreshPresent=$refreshPresent',
      );
      if (epoch != _sessionEpoch) return false;
      final prompt = coldStartNeedsBiometric(
        mobile: mobileBiometricPlatform,
        enabled: enabled,
        refreshPresent: refreshPresent,
      );
      if (!prompt) {
        logger.i('Cold start authenticate result=skipped');
        await loadStoredToken();
        return false;
      }
      final unlocked = await unlockWithBiometric();
      logger.i('Cold start authenticate result=$unlocked');
      if (epoch != _sessionEpoch) return false;
      if (!unlocked) {
        _biometricDeclined = true;
        logger.i('Cold start refresh result=skipped');
        return false;
      }
      final outcome = await refreshSessionOutcome();
      logger.i('Cold start refresh result=$outcome');
      if (epoch != _sessionEpoch) return false;
      if (outcome == RefreshOutcome.unauthorized) {
        await _clearStoredSession();
        return false;
      }
      if (outcome != RefreshOutcome.refreshed) return false;
      final stored = _jwtToken;
      if (stored == null || stored.isEmpty) return false;
      final verified = await _verifyStored(stored);
      if (epoch != _sessionEpoch) return false;
      if (!verified) {
        logger.i('Cold start verify result=false');
        return false;
      }
      return true;
    } catch (e) {
      if (epoch != _sessionEpoch) return false;
      logger.e('Cold start error: $e');
      return false;
    } finally {
      _coldStartSettled = true;
    }
  }

  String? _userIdFromJwt(String token) {
    try {
      final parts = token.split('.');
      if (parts.length != 3) return null;
      final payload = utf8.decode(
        base64Url.decode(base64Url.normalize(parts[1])),
      );
      final data = json.decode(payload);
      if (data is! Map) return null;
      final id = data['userId'] ?? data['id'];
      if (id == null) return null;
      final text = id.toString().trim();
      return text.isEmpty ? null : text;
    } catch (_) {
      return null;
    }
  }

  // Helper: Convert backend role string to Dart enum
  UserRole? _roleFromString(String roleString) {
    switch (roleString) {
      case 'VibeCoordinator':
        return UserRole.vibeCoordinator;
      case 'VibePlanner':
        return UserRole.vibePlanner;
      case 'Wanderer':
        return UserRole.wanderer;
      case 'admin':
        return UserRole
            .vibeCoordinator; // Map admin to coordinator for trip functions (or add AdminRole enum)
      default:
        return UserRole.wanderer; // Default fallback
    }
  }

  // Set current user role (stub for role changes)
  void setCurrentUserRole(UserRole role) {
    _currentUserRole = role;
    notifyListeners();
  }

  // Set current user (for profile updates; replace with real auth/backend later)
  void setCurrentUser(User user) {
    _currentUser = user;
    currentUserId = user.id;
    notifyListeners();
    logger.i('Set current user: ${user.firstName} ${user.lastName}');
  }

  // Update user (real API PATCH /api/auth/users/:id with token)
  Future<void> updateUser(Map<String, dynamic> updates) async {
    logger.i('At Update User API');
    try {
      final timeoutDuration = Duration(seconds: await AppConfig.timeoutSeconds);
      final token = _jwtToken;
      if (token == null) throw Exception('No token—log in first');

      final response = await api
          .patch(
            Uri.parse(
              (backendBaseUrl) +
                  apiUsersUpdate.replaceAll('{id}', currentUserId!),
            ),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: json.encode(updates),
          )
          .timeout(timeoutDuration);

      if (response.statusCode == 200) {
        final data = json.decode(response.body);
        _currentUser = User.fromJson(data['user']); // Reload updated user
        notifyListeners();
        logger.i('User updated from backend');
      } else if (response.statusCode == 401) {
        return;
      } else {
        throw Exception('Failed to update user: ${response.statusCode}');
      }
    } catch (e) {
      logger.e('Error updating user: $e');
      // Fallback: Optimistic local update
      if (_currentUser != null) {
        _currentUser = _currentUser!.copyWith(
          firstName: updates['firstName'] ?? _currentUser!.firstName,
          notificationPreferences: updates['notificationPreferences'] != null
              ? NotificationPreferences.fromJson(
                  updates['notificationPreferences'],
                )
              : _currentUser!.notificationPreferences,
        );
        notifyListeners();
      }
    }
  }

  void _markEmailVerified() {
    final current = _currentUser;
    if (current == null || current.emailVerified) return;
    _currentUser = current.copyWith(emailVerified: true);
    notifyListeners();
  }

  /// POST /api/auth/verify-email. Null means the link was accepted.
  Future<String?> verifyEmail(String token) async {
    final trimmed = token.trim();
    if (trimmed.isEmpty) return 'Invalid or expired verification link.';
    try {
      final timeoutDuration = Duration(seconds: await AppConfig.timeoutSeconds);
      final response = await http
          .post(
            Uri.parse(backendBaseUrl + apiAuthVerifyEmail),
            headers: {'Content-Type': 'application/json'},
            body: json.encode({'token': trimmed}),
          )
          .timeout(timeoutDuration);
      if (response.statusCode == 200) {
        _markEmailVerified();
        return null;
      }
      return _jsonMessage(response) ?? 'Invalid or expired verification link.';
    } catch (e) {
      logger.e('Verify email error: $e');
      return 'Could not verify your email.';
    }
  }

  /// POST /api/auth/resend-verification. Returns the message to show.
  Future<String> resendVerification() async {
    final token = _jwtToken;
    if (token == null || token.isEmpty) {
      return 'Log in to resend the verification email.';
    }
    try {
      final timeoutDuration = Duration(seconds: await AppConfig.timeoutSeconds);
      final response = await http
          .post(
            Uri.parse(backendBaseUrl + apiAuthResendVerification),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer $token',
            },
            body: '{}',
          )
          .timeout(timeoutDuration);
      return _jsonMessage(response) ??
          (response.statusCode == 200
              ? 'Verification email sent.'
              : 'Could not send the verification email.');
    } catch (e) {
      logger.e('Resend verification error: $e');
      return 'Could not send the verification email.';
    }
  }

  /// POST /api/auth/forgot-password. Null means the API accepted the request.
  /// The caller must not say whether the email is registered.
  Future<String?> forgotPassword(String email) async {
    try {
      final timeoutDuration = Duration(seconds: await AppConfig.timeoutSeconds);
      final response = await http
          .post(
            Uri.parse((backendBaseUrl) + apiAuthForgotPassword),
            headers: {'Content-Type': 'application/json'},
            body: json.encode({'email': email.trim()}),
          )
          .timeout(timeoutDuration);

      if (response.statusCode == 200) {
        logger.i('Forgot password request accepted');
        return null;
      }
      if (response.statusCode == 429) {
        logger.e('Forgot password status 429');
        throw AuthRateLimitException(
          _jsonMessage(response) ?? 'Too many attempts. Try again later.',
        );
      }
      logger.e('Forgot password status ${response.statusCode}');
      return 'Could not send the message. Try again.';
    } on AuthRateLimitException {
      rethrow;
    } catch (e) {
      logger.e('Forgot password error: $e');
      return 'Could not send the message. Try again.';
    }
  }
}
