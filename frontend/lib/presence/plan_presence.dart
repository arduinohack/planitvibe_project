import 'dart:convert';

import 'package:socket_io_client/socket_io_client.dart' as io;

import '../models/activity_reaction.dart';

class PlanViewer {
  final String userId;
  final String name;
  final String? activityId;

  const PlanViewer({
    required this.userId,
    required this.name,
    this.activityId,
  });
}

/// User id from a login JWT. Null when the token cannot be read.
String? userIdFromToken(String token) {
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

/// Null when the payload is not a presence list. An empty list is a real update.
List<PlanViewer>? parsePlanViewers(dynamic data) {
  if (data is! Map) return null;
  final users = data['users'];
  if (users is! List) return null;
  final rows = <PlanViewer>[];
  for (final item in users) {
    if (item is! Map) continue;
    final userId = item['userId']?.toString().trim() ?? '';
    if (userId.isEmpty) continue;
    final name = item['name']?.toString().trim() ?? '';
    final activity = item['activityId']?.toString().trim() ?? '';
    rows.add(
      PlanViewer(
        userId: userId,
        name: name.isEmpty ? 'Member' : name,
        activityId: activity.isEmpty ? null : activity,
      ),
    );
  }
  return rows;
}

class PlanReactionEvent {
  final String activityId;
  final String planId;
  final String type;
  final String userId;
  final bool? voted;
  final Map<String, int> counts;

  const PlanReactionEvent({
    required this.activityId,
    required this.planId,
    required this.type,
    required this.userId,
    required this.voted,
    required this.counts,
  });
}

/// Null when the payload is not a reaction for one activity.
PlanReactionEvent? parsePlanReaction(dynamic data) {
  Map? body;
  if (data is Map) {
    body = data;
  } else if (data is String) {
    try {
      final decoded = json.decode(data);
      if (decoded is Map) body = decoded;
    } catch (_) {
      return null;
    }
  }
  if (body == null) return null;
  final activityId = body['activityId']?.toString().trim() ?? '';
  final type = body['type']?.toString().trim() ?? '';
  final rawCounts = body['counts'];
  if (activityId.isEmpty ||
      !ActivityReactions.types.contains(type) ||
      rawCounts is! Map) {
    return null;
  }
  final counts = <String, int>{};
  for (final name in ActivityReactions.types) {
    final value = rawCounts[name];
    counts[name] = value is num ? value.round() : 0;
  }
  final voted = body['voted'];
  return PlanReactionEvent(
    activityId: activityId,
    planId: body['planId']?.toString().trim() ?? '',
    type: type,
    userId: body['userId']?.toString().trim() ?? '',
    voted: voted is bool ? voted : null,
    counts: counts,
  );
}

/// One socket for the open plan. Errors stay quiet when the network blocks sockets.
class PlanPresenceConnection {
  PlanPresenceConnection({required this.onUsers, this.onReaction});

  final void Function(List<PlanViewer> users) onUsers;
  final void Function(PlanReactionEvent event)? onReaction;

  io.Socket? _socket;
  String? _planId;
  String? _editingActivityId;
  bool _closed = false;

  void connect({
    required String baseUrl,
    required String token,
    required String planId,
  }) {
    if (_closed || token.isEmpty || planId.isEmpty) return;
    _planId = planId;
    final origin = baseUrl.endsWith('/')
        ? baseUrl.substring(0, baseUrl.length - 1)
        : baseUrl;
    try {
      final socket = io.io(
        origin,
        io.OptionBuilder()
            .setTransports(const ['polling', 'websocket'])
            .setAuth({'token': token})
            .enableForceNew()
            .build(),
      );
      if (_closed) {
        socket.dispose();
        return;
      }
      _socket = socket;
      socket.onConnect((_) {
        if (_closed) return;
        try {
          socket.emit('join', {'planId': planId});
          _emitEditing();
        } catch (_) {}
      });
      socket.on('presence', (data) {
        if (_closed) return;
        try {
          final users = parsePlanViewers(data);
          if (users == null) return;
          onUsers(users);
        } catch (_) {}
      });
      socket.on('reaction', (data) {
        if (_closed) return;
        final handler = onReaction;
        if (handler == null) return;
        try {
          final event = parsePlanReaction(data);
          if (event == null) return;
          final openPlan = _planId;
          if (event.planId.isNotEmpty &&
              openPlan != null &&
              event.planId != openPlan) {
            return;
          }
          handler(event);
        } catch (_) {}
      });
      socket.onConnectError((_) {});
      socket.onError((_) {});
    } catch (_) {}
  }

  void editing(String planId, String activityId) {
    if (activityId.isEmpty) return;
    _planId = planId;
    _editingActivityId = activityId;
    _emitEditing();
  }

  void idle(String planId) {
    _editingActivityId = null;
    final socket = _socket;
    if (_closed || socket == null) return;
    try {
      socket.emit('idle', {'planId': planId});
    } catch (_) {}
  }

  void close() {
    _closed = true;
    final socket = _socket;
    _socket = null;
    if (socket == null) return;
    try {
      socket.dispose();
    } catch (_) {}
  }

  void _emitEditing() {
    final socket = _socket;
    final planId = _planId;
    final activityId = _editingActivityId;
    if (_closed || socket == null || planId == null || activityId == null) {
      return;
    }
    if (activityId.isEmpty) return;
    try {
      socket.emit('editing', {'planId': planId, 'activityId': activityId});
    } catch (_) {}
  }
}
