import 'dart:convert';
import 'dart:typed_data';

import 'activity_attachment.dart';

const attachmentCacheFolder = 'attachments';
const attachmentCachePrefsKey = 'planitvibe.attachmentFiles';

const _extensionByMime = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
};

/// Android and iOS keep a viewed file. Web and desktop always fetch.
bool attachmentCacheEnabled({required bool web, required String platform}) {
  if (web) return false;
  return platform == 'android' || platform == 'iOS';
}

String attachmentCacheExtension({
  required String mimeType,
  required String filename,
}) {
  final mime = mimeType.toLowerCase().split(';').first.trim();
  final fromMime = _extensionByMime[mime];
  if (fromMime != null) return fromMime;
  final lower = filename.trim().toLowerCase();
  final dot = lower.lastIndexOf('.');
  if (dot >= 0 && dot < lower.length - 1) {
    var extension = lower.substring(dot + 1);
    if (extension == 'jpeg') extension = 'jpg';
    if (attachmentFileExtensions.contains(extension)) return extension;
  }
  if (attachmentIsPdf(mimeType, filename)) return 'pdf';
  return 'bin';
}

/// Stable relative name, `attachments/<id>.<ext>`. The id cannot add `..`.
String attachmentCacheRelativePath({
  required String attachmentId,
  required String mimeType,
  required String filename,
}) {
  final id = _safeId(attachmentId);
  final extension = attachmentCacheExtension(
    mimeType: mimeType,
    filename: filename,
  );
  return '$attachmentCacheFolder/$id.$extension';
}

/// Absolute path under the app documents directory, or null when the root is empty.
String? attachmentCacheFullPath({
  required String documentsDir,
  required String attachmentId,
  required String mimeType,
  required String filename,
  String separator = '/',
}) {
  final root = documentsDir.trim();
  if (root.isEmpty || separator.isEmpty) return null;
  final relative = attachmentCacheRelativePath(
    attachmentId: attachmentId,
    mimeType: mimeType,
    filename: filename,
  );
  if (relative.contains('..') || relative.contains('\\')) return null;
  final prefix = root.endsWith(separator) ? root : '$root$separator';
  return '$prefix${relative.replaceAll('/', separator)}';
}

String _safeId(String attachmentId) {
  final cleaned = attachmentId.trim().replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '');
  return cleaned.isEmpty ? 'attachment' : cleaned;
}

class AttachmentCacheIndex {
  final Map<String, String> paths;

  const AttachmentCacheIndex([this.paths = const {}]);

  String? pathFor(String attachmentId) {
    final id = attachmentId.trim();
    if (id.isEmpty) return null;
    final path = paths[id];
    if (path == null || path.trim().isEmpty) return null;
    return path;
  }

  AttachmentCacheIndex withPath(String attachmentId, String path) {
    final id = attachmentId.trim();
    final stored = path.trim();
    if (id.isEmpty || stored.isEmpty) return this;
    return AttachmentCacheIndex({...paths, id: stored});
  }

  AttachmentCacheIndex without(String attachmentId) {
    final id = attachmentId.trim();
    if (!paths.containsKey(id)) return this;
    final next = Map<String, String>.from(paths)..remove(id);
    return AttachmentCacheIndex(next);
  }

  String encode() => jsonEncode(paths);

  static AttachmentCacheIndex decode(String raw) {
    final data = jsonDecode(raw);
    if (data is! Map) return const AttachmentCacheIndex();
    final paths = <String, String>{};
    data.forEach((key, value) {
      final id = key.toString().trim();
      final path = value == null ? '' : value.toString().trim();
      if (id.isEmpty || path.isEmpty) return;
      paths[id] = path;
    });
    return AttachmentCacheIndex(paths);
  }
}

/// Local copy of a viewed attachment. Web passes null and always downloads.
abstract class AttachmentFileCache {
  Future<Set<String>> savedIds();

  Future<Uint8List?> read(String attachmentId);

  Future<bool> save({
    required String attachmentId,
    required String filename,
    required String mimeType,
    required Uint8List bytes,
  });

  Future<void> remove(String attachmentId);
}
