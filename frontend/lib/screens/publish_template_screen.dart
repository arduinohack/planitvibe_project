import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/membership_tier.dart';
import '../models/published_template.dart';
import '../providers/plan_provider.dart';
import '../providers/user_provider.dart';
import '../utils/plus_upgrade.dart';
import 'login_screen.dart';

class PublishTemplateScreen extends StatefulWidget {
  final String planId;
  final String? templateId;
  final String initialTitle;
  final String initialDescription;
  final String initialCity;
  final int initialTripLength;
  final String initialVibe;
  final String initialCover;

  const PublishTemplateScreen({
    super.key,
    required this.planId,
    this.templateId,
    this.initialTitle = '',
    this.initialDescription = '',
    this.initialCity = '',
    this.initialTripLength = 1,
    this.initialVibe = '',
    this.initialCover = '',
  });

  @override
  State<PublishTemplateScreen> createState() => _PublishTemplateScreenState();
}

class _PublishTemplateScreenState extends State<PublishTemplateScreen> {
  late final TextEditingController _title;
  late final TextEditingController _description;
  late final TextEditingController _city;
  late final TextEditingController _length;
  late final TextEditingController _vibe;
  late final TextEditingController _cover;
  var _refreshStops = false;
  var _loading = false;
  String? _error;
  String _blocked = '';
  String? _previewed;
  List<String> _removed = const [];
  PublishedTemplateCard? _preview;

  bool get _editing => (widget.templateId ?? '').isNotEmpty;

  @override
  void initState() {
    super.initState();
    _title = TextEditingController(text: widget.initialTitle);
    _description = TextEditingController(text: widget.initialDescription);
    _city = TextEditingController(text: widget.initialCity);
    final length = widget.initialTripLength < 1
        ? 1
        : (widget.initialTripLength > 60 ? 60 : widget.initialTripLength);
    _length = TextEditingController(text: '$length');
    _vibe = TextEditingController(text: widget.initialVibe);
    _cover = TextEditingController(text: widget.initialCover);
    for (final controller in [_title, _description, _city, _length, _vibe, _cover]) {
      controller.addListener(_clearPreview);
    }
  }

  @override
  void dispose() {
    for (final controller in [_title, _description, _city, _length, _vibe, _cover]) {
      controller.removeListener(_clearPreview);
      controller.dispose();
    }
    super.dispose();
  }

  void _clearPreview() {
    if (_preview == null && _blocked.isEmpty && _error == null) return;
    setState(() {
      _preview = null;
      _removed = const [];
      _blocked = '';
      _previewed = null;
      _error = null;
    });
  }

  String _signature() {
    return [
      _title.text.trim(),
      _description.text.trim(),
      _city.text.trim(),
      _length.text.trim(),
      _vibe.text.trim(),
      _cover.text.trim(),
    ].join('|');
  }

  Map<String, dynamic>? _fields() {
    final title = _title.text.trim();
    final description = _description.text.trim();
    final city = _city.text.trim();
    final vibe = _vibe.text.trim();
    final length = int.tryParse(_length.text.trim());
    if (title.isEmpty || description.isEmpty || city.isEmpty || vibe.isEmpty) {
      return null;
    }
    if (length == null || length < 1 || length > 60) return null;
    if (description.contains('\n')) return null;
    return {
      'title': title,
      'description': description,
      'city': city,
      'tripLength': length,
      'vibe': vibe,
      'coverImage': _cover.text.trim(),
      if (_editing) 'refresh': _refreshStops,
    };
  }

  bool get _canPublish {
    if (_loading) return false;
    if (_blocked.isNotEmpty) return false;
    if (_editing) return true;
    return _preview != null && _previewed == _signature();
  }

  Future<void> _endSession() async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    planProvider.clearPlans();
    await userProvider.logout();
    if (!mounted) return;
    navigator.pushAndRemoveUntil(
      MaterialPageRoute(builder: (context) => const LoginScreen()),
      (route) => false,
    );
  }

  Future<void> _upgrade(LibraryResult result) async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final pack = checkoutPackForTier(result.nextTier);
    await showPlusUpgradeDialog(
      context,
      message: result.error ?? 'Upgrade to Plus to publish a template.',
      token: userProvider.token,
      pack: pack ?? 'plus_monthly',
      tierName: result.nextTierName,
      showUpgrade: pack != null,
    );
  }

  Future<void> _previewTemplate() async {
    final fields = _fields();
    if (fields == null) {
      setState(() => _error = 'Add a title, one-line description, city, days, and vibe.');
      return;
    }
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    setState(() {
      _loading = true;
      _error = null;
    });
    final result = await planProvider.previewPublishedTemplate(
      planId: widget.planId,
      fields: fields,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession();
      return;
    }
    if (result.status == 402) {
      setState(() => _loading = false);
      await _upgrade(result);
      return;
    }
    final preview = result.preview;
    if (result.status != 200 || preview == null) {
      setState(() {
        _loading = false;
        _error = result.error ?? 'Could not preview this template';
      });
      return;
    }
    setState(() {
      _loading = false;
      _preview = preview.card;
      _removed = preview.removed;
      _blocked = preview.blocked;
      _previewed = _signature();
      _error = null;
    });
  }

  Future<void> _publish() async {
    if (!_canPublish) return;
    final fields = _fields();
    if (fields == null) {
      setState(() => _error = 'Add a title, one-line description, city, days, and vibe.');
      return;
    }
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _loading = true;
      _error = null;
    });
    final result = _editing
        ? await planProvider.updatePublishedTemplate(
            templateId: widget.templateId!,
            fields: fields,
            token: userProvider.token,
          )
        : await planProvider.publishTemplate(
            planId: widget.planId,
            fields: fields,
            token: userProvider.token,
          );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession();
      return;
    }
    if (result.status == 402) {
      setState(() => _loading = false);
      await _upgrade(result);
      return;
    }
    final saved = result.template;
    if ((result.status != 200 && result.status != 201) || saved == null) {
      setState(() {
        _loading = false;
        _error = result.error ?? 'Could not publish this template';
      });
      return;
    }
    final path = saved.sharePath;
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          path.isEmpty
              ? 'Template saved'
              : 'Published. Share https://planitvibe.com$path',
        ),
      ),
    );
    if (!mounted) return;
    Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    final preview = _preview;
    return Scaffold(
      appBar: AppBar(
        title: Text(_editing ? 'Edit template' : 'Publish as template'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'The public page shows days, stops, notes, and times. Bookings, confirmation numbers, addresses, and private notes are removed.',
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _title,
            decoration: const InputDecoration(labelText: 'Title'),
          ),
          TextField(
            controller: _description,
            decoration: const InputDecoration(labelText: 'One-line description'),
          ),
          TextField(
            controller: _city,
            decoration: const InputDecoration(labelText: 'City'),
          ),
          TextField(
            controller: _length,
            decoration: const InputDecoration(labelText: 'Trip length (days)'),
            keyboardType: TextInputType.number,
          ),
          TextField(
            controller: _vibe,
            decoration: const InputDecoration(labelText: 'Vibe'),
          ),
          TextField(
            controller: _cover,
            decoration: const InputDecoration(
              labelText: 'Cover image link',
              hintText: 'https://',
            ),
          ),
          if (_editing)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Replace stops with the current plan'),
              value: _refreshStops,
              onChanged: _loading
                  ? null
                  : (value) => setState(() => _refreshStops = value == true),
            ),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _loading ? null : _previewTemplate,
              child: const Text('Preview'),
            ),
          ),
          if (_loading) const LinearProgressIndicator(),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: const TextStyle(color: Colors.red)),
            ),
          if (_blocked.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_blocked, style: const TextStyle(color: Colors.red)),
            ),
          if (preview != null) ...[
            const SizedBox(height: 16),
            Text(
              'This is what will be shared',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 8),
            Text(preview.title, style: const TextStyle(fontSize: 20)),
            Text(preview.description),
            Text('${preview.city} · ${preview.tripLength} days · ${preview.vibe}'),
            Text('By ${preview.creatorName}'),
            if (_removed.isNotEmpty) ...[
              const SizedBox(height: 12),
              const Text('Removed', style: TextStyle(fontWeight: FontWeight.bold)),
              for (final line in _removed) Text(line),
            ],
            const SizedBox(height: 12),
            for (final stop in preview.stops)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(_stopLine(stop)),
              ),
          ],
          const SizedBox(height: 12),
          const Text('Your first and last name will be shown on this template.'),
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _canPublish ? _publish : null,
              child: Text(_editing ? 'Save' : 'Publish'),
            ),
          ),
        ],
      ),
    );
  }
}

String _stopLine(PublishedStop stop) {
  final when = [
    if (stop.day != null) 'Day ${stop.day}',
    if (stop.start.isNotEmpty && stop.end.isNotEmpty) '${stop.start}–${stop.end}',
    if (stop.start.isNotEmpty && stop.end.isEmpty) stop.start,
  ].join(' ');
  final details = stop.details.trim().isEmpty ? '' : '\n${stop.details.trim()}';
  final name = stop.name.trim().isEmpty ? 'Stop' : stop.name.trim();
  return '$when $name$details'.trim();
}
