import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:printing/printing.dart';
import 'package:provider/provider.dart';

import '../models/activity_attachment.dart';
import '../providers/plan_provider.dart';
import '../providers/user_provider.dart';
import '../utils/activity_attachment.dart';
import '../utils/plus_upgrade.dart';
import '../utils/attachment_cache.dart';
import '../utils/attachment_cache_binding.dart';
import '../utils/attachment_picker.dart';

/// Loads attachments for one activity and shows add, view, and delete.
class ActivityAttachmentsSection extends StatelessWidget {
  final String activityId;
  final String planId;

  const ActivityAttachmentsSection({
    super.key,
    required this.activityId,
    required this.planId,
  });

  @override
  Widget build(BuildContext context) {
    final user = context.watch<UserProvider>();
    final plans = context.watch<PlanProvider>();
    var trialReadOnly = false;
    for (final plan in plans.plans) {
      if (plan.id == planId) {
        trialReadOnly = plan.trialReadOnly;
        break;
      }
    }
    return ActivityAttachmentsPanel(
      allowAdd: !trialReadOnly,
      storedRole: plans.viewerStoredRole(planId, user.currentUserId),
      userId: user.currentUserId,
      loadAttachments: () => plans.fetchActivityAttachments(
        activityId: activityId,
        token: context.read<UserProvider>().token,
      ),
      uploadAttachment: (filename, bytes) => plans.uploadActivityAttachment(
        activityId: activityId,
        filename: filename,
        bytes: bytes,
        token: context.read<UserProvider>().token,
      ),
      fetchFile: (attachmentId) => plans.fetchActivityAttachmentFile(
        attachmentId: attachmentId,
        token: context.read<UserProvider>().token,
      ),
      deleteAttachment: (attachmentId) => plans.deleteActivityAttachment(
        attachmentId: attachmentId,
        token: context.read<UserProvider>().token,
      ),
      fileCache: createAttachmentFileCache(),
    );
  }
}

class ActivityAttachmentsPanel extends StatefulWidget {
  final String? storedRole;
  final String? userId;
  final bool allowAdd;
  final Future<ActivityAttachmentListResult> Function() loadAttachments;
  final Future<ActivityAttachmentWriteResult> Function(
    String filename,
    Uint8List bytes,
  )
  uploadAttachment;
  final Future<ActivityAttachmentFileResult> Function(String attachmentId)
  fetchFile;
  final Future<ActivityAttachmentWriteResult> Function(String attachmentId)
  deleteAttachment;
  final Future<AttachmentPickResult> Function()? pickFile;
  final AttachmentFileCache? fileCache;

  const ActivityAttachmentsPanel({
    super.key,
    required this.storedRole,
    required this.userId,
    this.allowAdd = true,
    required this.loadAttachments,
    required this.uploadAttachment,
    required this.fetchFile,
    required this.deleteAttachment,
    this.pickFile,
    this.fileCache,
  });

  @override
  State<ActivityAttachmentsPanel> createState() =>
      _ActivityAttachmentsPanelState();
}

class _ActivityAttachmentsPanelState extends State<ActivityAttachmentsPanel> {
  List<ActivityAttachment> _items = const [];
  Set<String> _saved = const {};
  bool _loading = true;
  bool _busy = false;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    _load();
    _refreshSaved();
  }

  Future<void> _refreshSaved() async {
    final cache = widget.fileCache;
    if (cache == null) return;
    final ids = await cache.savedIds();
    if (!mounted) return;
    setState(() => _saved = ids);
  }

  Future<void> _load() async {
    final result = await widget.loadAttachments();
    if (!mounted) return;
    if (result.status != 200) {
      final message = attachmentErrorMessage(result.status, result.error);
      setState(() {
        _loading = false;
        _loadError = message;
      });
      _snack(message);
      return;
    }
    setState(() {
      _loading = false;
      _loadError = null;
      _items = result.attachments;
    });
  }

  void _snack(String message) {
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(
      context,
    )?.showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _add() async {
    if (_busy) return;
    final picked = await (widget.pickFile ?? pickAttachmentFile)();
    if (!mounted || picked.cancelled) return;
    final file = picked.file;
    if (file == null) {
      _snack('Could not read that file.');
      return;
    }
    if (file.bytes.isEmpty) {
      _snack('File is required');
      return;
    }
    if (file.bytes.length > attachmentMaxBytes) {
      _snack(attachmentSizeMessage);
      return;
    }
    setState(() => _busy = true);
    final result = await widget.uploadAttachment(file.filename, file.bytes);
    if (!mounted) return;
    if (result.status == 402) {
      setState(() => _busy = false);
      await showPlusUpgradeDialog(
        context,
        message: result.error ?? 'Upgrade to Plus to add a file.',
        token: context.read<UserProvider>().token,
      );
      return;
    }
    if (result.status != 201) {
      setState(() => _busy = false);
      _snack(attachmentErrorMessage(result.status, result.error));
      return;
    }
    setState(() => _busy = false);
    await _load();
  }

  Future<void> _view(ActivityAttachment item) async {
    if (_busy) return;
    setState(() => _busy = true);
    final cached = await widget.fileCache?.read(item.id);
    if (!mounted) return;
    if (cached != null && cached.isNotEmpty) {
      setState(() => _busy = false);
      await _open(item, cached, item.mimeType);
      return;
    }
    final result = await widget.fetchFile(item.id);
    if (!mounted) return;
    final bytes = result.bytes;
    if (result.status != 200 || bytes == null || bytes.isEmpty) {
      setState(() => _busy = false);
      _snack(attachmentErrorMessage(result.status, result.error));
      return;
    }
    final mime = result.mimeType.isNotEmpty ? result.mimeType : item.mimeType;
    final saved = await _store(item, bytes, mime);
    if (!mounted) return;
    setState(() {
      _busy = false;
      if (saved) _saved = {..._saved, item.id};
    });
    await _open(item, bytes, mime);
  }

  Future<bool> _store(
    ActivityAttachment item,
    Uint8List bytes,
    String mime,
  ) async {
    final cache = widget.fileCache;
    if (cache == null) return false;
    return cache.save(
      attachmentId: item.id,
      filename: item.filename,
      mimeType: mime,
      bytes: bytes,
    );
  }

  Future<void> _open(ActivityAttachment item, Uint8List bytes, String mime) {
    if (attachmentIsPdf(mime, item.filename)) {
      return _showPdf(item.filename, bytes);
    }
    if (attachmentIsImage(mime, item.filename)) {
      return _showImage(item.filename, bytes);
    }
    _snack('Could not open this file.');
    return Future<void>.value();
  }

  Future<void> _showImage(String filename, Uint8List bytes) {
    return showDialog<void>(
      context: context,
      builder: (context) {
        return Dialog.fullscreen(
          child: Scaffold(
            appBar: AppBar(
              title: Text(filename),
              leading: IconButton(
                tooltip: 'Close',
                icon: const Icon(Icons.close),
                onPressed: () => Navigator.pop(context),
              ),
            ),
            body: Center(
              child: InteractiveViewer(
                child: Image.memory(
                  bytes,
                  errorBuilder: (context, error, stackTrace) {
                    return const Padding(
                      padding: EdgeInsets.all(24),
                      child: Text('Could not open this image.'),
                    );
                  },
                ),
              ),
            ),
          ),
        );
      },
    );
  }

  Future<void> _showPdf(String filename, Uint8List bytes) {
    return showDialog<void>(
      context: context,
      builder: (context) {
        return Dialog.fullscreen(
          child: Scaffold(
            appBar: AppBar(
              title: Text(filename),
              leading: IconButton(
                tooltip: 'Close',
                icon: const Icon(Icons.close),
                onPressed: () => Navigator.pop(context),
              ),
            ),
            body: PdfPreview(
              build: (format) async => bytes,
              canChangePageFormat: false,
              canChangeOrientation: false,
              canDebug: false,
              pdfFileName: filename,
              onError: (context, error) {
                return const Center(child: Text('Could not open this PDF.'));
              },
            ),
          ),
        );
      },
    );
  }

  Future<void> _delete(ActivityAttachment item) async {
    if (_busy) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('Delete attachment'),
          content: Text('Delete ${item.filename}?'),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Delete'),
            ),
          ],
        );
      },
    );
    if (confirmed != true || !mounted) return;
    setState(() => _busy = true);
    final result = await widget.deleteAttachment(item.id);
    if (!mounted) return;
    setState(() => _busy = false);
    if (result.status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: result.error ??
            'This plan is read-only on the free trial. Upgrade to Plus to edit it.',
        token: context.read<UserProvider>().token,
      );
      return;
    }
    if (result.status != 200) {
      _snack(attachmentErrorMessage(result.status, result.error));
      return;
    }
    await widget.fileCache?.remove(item.id);
    if (!mounted) return;
    setState(() => _saved = {..._saved}..remove(item.id));
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final canAdd =
        widget.allowAdd && canAddActivityAttachment(widget.storedRole);
    final theme = Theme.of(context);
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Attachments',
          style: theme.textTheme.titleMedium?.copyWith(
            fontWeight: FontWeight.bold,
          ),
        ),
        if (canAdd)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: _busy ? null : _add,
              icon: _busy
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.attach_file),
              label: const Text('Add attachment'),
            ),
          ),
        if (_loading)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 12),
            child: Center(
              child: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          ),
        if (_loadError != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_loadError!),
          ),
        if (!_loading && _loadError == null && _items.isEmpty)
          const Padding(
            padding: EdgeInsets.only(top: 8),
            child: Text('No files yet.'),
          ),
        for (final item in _items) _row(item),
      ],
    );
  }

  Widget _row(ActivityAttachment item) {
    final canDelete = canDeleteActivityAttachment(
      storedRole: widget.storedRole,
      userId: widget.userId,
      uploadedBy: item.uploadedBy,
    );
    return Padding(
      padding: const EdgeInsets.only(top: 4),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.filename,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                Text(
                  formatAttachmentSize(item.size),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                if (_saved.contains(item.id))
                  Text(
                    'Saved on device',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
              ],
            ),
          ),
          TextButton(
            onPressed: _busy ? null : () => _view(item),
            child: const Text('View'),
          ),
          if (canDelete)
            IconButton(
              tooltip: 'Delete attachment',
              icon: const Icon(Icons.delete),
              onPressed: _busy ? null : () => _delete(item),
            ),
        ],
      ),
    );
  }
}
