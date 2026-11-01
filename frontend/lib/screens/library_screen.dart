import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/published_template.dart';
import '../providers/plan_provider.dart';
import '../providers/user_provider.dart';
import '../utils/plus_upgrade.dart';
import 'login_screen.dart';
import 'plan_detail_screen.dart';
import 'publish_template_screen.dart';

class LibraryScreen extends StatefulWidget {
  const LibraryScreen({super.key});

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  final _query = TextEditingController();
  final _city = TextEditingController();
  final _length = TextEditingController();
  final _tag = TextEditingController();
  var _loading = true;
  String? _error;
  List<PublishedTemplateCard> _templates = const [];
  List<PublishedTemplateCard> _mine = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  @override
  void dispose() {
    _query.dispose();
    _city.dispose();
    _length.dispose();
    _tag.dispose();
    super.dispose();
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

  Future<void> _load() async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    setState(() {
      _loading = true;
      _error = null;
    });
    final browsed = await planProvider.browsePublishedTemplates(
      query: _query.text,
      city: _city.text,
      length: _length.text,
      tag: _tag.text,
    );
    if (!mounted) return;
    if (browsed.status != 200) {
      setState(() {
        _loading = false;
        _error = browsed.error ?? 'Could not load templates';
      });
      return;
    }
    LibraryResult? owned;
    if ((userProvider.token ?? '').isNotEmpty) {
      owned = await planProvider.fetchOwnedPublishedTemplates(userProvider.token);
      if (!mounted) return;
      if (owned.status == 401) {
        await _endSession();
        return;
      }
    }
    setState(() {
      _loading = false;
      _templates = browsed.templates;
      _mine = owned == null || owned.status != 200 ? const [] : owned.templates;
      _error = null;
    });
  }

  Future<void> _open(PublishedTemplateCard card) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (context) => PublishedTemplateScreen(templateId: card.id),
      ),
    );
    if (changed == true && mounted) await _load();
  }

  Future<void> _edit(PublishedTemplateCard card) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (context) => PublishTemplateScreen(
          planId: card.sourcePlanId,
          templateId: card.id,
          initialTitle: card.title,
          initialDescription: card.description,
          initialCity: card.city,
          initialTripLength: card.tripLength,
          initialVibe: card.vibe,
          initialCover: card.coverImage,
        ),
      ),
    );
    if (changed == true && mounted) await _load();
  }

  Future<void> _unpublish(PublishedTemplateCard card) async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.unpublishTemplate(
      templateId: card.id,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession();
      return;
    }
    if (result.status != 200) {
      messenger.showSnackBar(
        SnackBar(content: Text(result.error ?? 'Could not unpublish this template')),
      );
      return;
    }
    messenger.showSnackBar(const SnackBar(content: Text('Unpublished')));
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Library')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _query,
            decoration: const InputDecoration(labelText: 'Search'),
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _load(),
          ),
          TextField(
            controller: _city,
            decoration: const InputDecoration(labelText: 'City'),
          ),
          TextField(
            controller: _length,
            decoration: const InputDecoration(labelText: 'Length (days)'),
            keyboardType: TextInputType.number,
          ),
          TextField(
            controller: _tag,
            decoration: const InputDecoration(labelText: 'Tag'),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(onPressed: _load, child: const Text('Search')),
          ),
          if (_loading) const LinearProgressIndicator(),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error!, style: const TextStyle(color: Colors.red)),
            ),
          if (_mine.isNotEmpty) ...[
            const SizedBox(height: 8),
            const Text('Your templates', style: TextStyle(fontSize: 18)),
            for (final card in _mine) _ownedTile(card),
          ],
          const SizedBox(height: 8),
          if (!_loading && _templates.isEmpty && _error == null)
            const Padding(
              padding: EdgeInsets.only(top: 24),
              child: Text(
                'No templates yet',
                style: TextStyle(fontSize: 20),
                textAlign: TextAlign.center,
              ),
            ),
          for (final card in _templates)
            Card(
              child: ListTile(
                title: Text(card.title),
                subtitle: Text(
                  '${card.city} · ${card.tripLength} days · ${card.vibe}\n'
                  'By ${card.creatorName} · ${card.copyCount} copies',
                ),
                isThreeLine: true,
                onTap: () => _open(card),
              ),
            ),
        ],
      ),
    );
  }

  Widget _ownedTile(PublishedTemplateCard card) {
    final state = card.published ? 'Published' : 'Unpublished';
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            title: Text(card.title),
            subtitle: Text(
              '$state · ${card.copyCount} copies · ${card.viewCount} views',
            ),
          ),
          Row(
            children: [
              TextButton(onPressed: () => _edit(card), child: const Text('Edit')),
              if (card.published)
                TextButton(
                  onPressed: () => _unpublish(card),
                  child: const Text('Unpublish'),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class PublishedTemplateScreen extends StatefulWidget {
  final String templateId;

  const PublishedTemplateScreen({super.key, required this.templateId});

  @override
  State<PublishedTemplateScreen> createState() => _PublishedTemplateScreenState();
}

class _PublishedTemplateScreenState extends State<PublishedTemplateScreen> {
  var _loading = true;
  String? _error;
  PublishedTemplateCard? _template;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
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

  Future<void> _load() async {
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    setState(() {
      _loading = true;
      _error = null;
    });
    final result = await planProvider.readPublishedTemplate(widget.templateId);
    if (!mounted) return;
    final template = result.template;
    if (result.status != 200 || template == null) {
      setState(() {
        _loading = false;
        _error = result.error ?? 'Could not load this template';
      });
      return;
    }
    setState(() {
      _loading = false;
      _template = template;
    });
  }

  Future<void> _copy() async {
    final template = _template;
    if (template == null) return;
    final request = await showDialog<_CopyRequest>(
      context: context,
      builder: (context) => _CopyDialog(initialName: template.title),
    );
    if (request == null || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.copyPublishedTemplate(
      templateId: template.id,
      name: request.name,
      startDate: request.startDate,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession();
      return;
    }
    if (result.status == 402) {
      await showPlusUpgradeDialog(
        context,
        message: result.error ?? 'Upgrade to own more plans.',
        token: userProvider.token,
        pack: planProvider.upgradePack ?? 'plus_monthly',
        tierName: planProvider.upgradeTierName,
        showUpgrade: planProvider.upgradePack != null,
      );
      return;
    }
    final created = result.plan;
    if (result.status != 201 || created == null) {
      messenger.showSnackBar(
        SnackBar(content: Text(result.error ?? 'Could not copy this template')),
      );
      return;
    }
    await userProvider.loadPlanAccess();
    if (!mounted) return;
    await navigator.push(
      MaterialPageRoute(builder: (context) => PlanDetailScreen(plan: created)),
    );
  }

  Future<void> _report() async {
    final template = _template;
    if (template == null) return;
    final reason = await showDialog<String>(
      context: context,
      builder: (context) => const _ReportDialog(),
    );
    if (reason == null || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.reportPublishedTemplate(
      templateId: template.id,
      reason: reason,
      token: userProvider.token,
    );
    if (!mounted) return;
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          result.status == 201
              ? 'Report sent'
              : (result.error ?? 'Could not send the report'),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final template = _template;
    return Scaffold(
      appBar: AppBar(title: Text(template?.title ?? 'Template')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : template == null
              ? Center(child: Text(_error ?? 'Could not load this template'))
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    Text(template.title, style: const TextStyle(fontSize: 22)),
                    const SizedBox(height: 4),
                    Text(template.description),
                    const SizedBox(height: 4),
                    Text(
                      '${template.city} · ${template.tripLength} days · ${template.vibe}',
                    ),
                    Text('By ${template.creatorName}'),
                    Text('${template.copyCount} copies · ${template.viewCount} views'),
                    if (template.sharePath.isNotEmpty)
                      Text('https://planitvibe.com${template.sharePath}'),
                    const SizedBox(height: 12),
                    for (final stop in template.stops)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Text(_libraryStop(stop)),
                      ),
                    Row(
                      children: [
                        TextButton(onPressed: _copy, child: const Text('Copy')),
                        TextButton(onPressed: _report, child: const Text('Report')),
                      ],
                    ),
                  ],
                ),
    );
  }
}

String _libraryStop(PublishedStop stop) {
  final when = [
    if (stop.day != null) 'Day ${stop.day}',
    if (stop.start.isNotEmpty && stop.end.isNotEmpty) '${stop.start}–${stop.end}',
    if (stop.start.isNotEmpty && stop.end.isEmpty) stop.start,
  ].join(' ');
  final details = stop.details.trim().isEmpty ? '' : '\n${stop.details.trim()}';
  return '$when ${stop.name}$details'.trim();
}

class _CopyRequest {
  final String name;
  final String startDate;

  const _CopyRequest({required this.name, required this.startDate});
}

class _CopyDialog extends StatefulWidget {
  final String initialName;

  const _CopyDialog({required this.initialName});

  @override
  State<_CopyDialog> createState() => _CopyDialogState();
}

class _CopyDialogState extends State<_CopyDialog> {
  late final TextEditingController _name;
  DateTime? _start;
  String? _error;

  @override
  void initState() {
    super.initState();
    _name = TextEditingController(text: widget.initialName);
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  String _dayLabel(DateTime day) {
    final year = day.year.toString().padLeft(4, '0');
    final month = day.month.toString().padLeft(2, '0');
    final date = day.day.toString().padLeft(2, '0');
    return '$year-$month-$date';
  }

  Future<void> _pickStart() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _start ?? DateTime.now(),
      firstDate: DateTime(2000),
      lastDate: DateTime(2100),
    );
    if (picked == null) return;
    setState(() {
      _start = picked;
      _error = null;
    });
  }

  void _submit() {
    final name = _name.text.trim();
    final start = _start;
    if (name.isEmpty) {
      setState(() => _error = 'Name is required.');
      return;
    }
    if (start == null) {
      setState(() => _error = 'Choose a start date.');
      return;
    }
    Navigator.pop(context, _CopyRequest(name: name, startDate: _dayLabel(start)));
  }

  @override
  Widget build(BuildContext context) {
    final start = _start;
    return AlertDialog(
      title: const Text('Copy template'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _name,
              decoration: const InputDecoration(labelText: 'Plan name'),
            ),
            const SizedBox(height: 12),
            const Text(
              'The first activity moves to this date. Later activities keep the same spacing.',
            ),
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: _pickStart,
              child: Text(start == null ? 'Choose date' : _dayLabel(start)),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: const TextStyle(color: Colors.red)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        TextButton(onPressed: _submit, child: const Text('Copy')),
      ],
    );
  }
}

class _ReportDialog extends StatefulWidget {
  const _ReportDialog();

  @override
  State<_ReportDialog> createState() => _ReportDialogState();
}

class _ReportDialogState extends State<_ReportDialog> {
  final _reason = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  void _submit() {
    final reason = _reason.text.trim();
    if (reason.isEmpty) {
      setState(() => _error = 'A reason is required.');
      return;
    }
    Navigator.pop(context, reason);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Report template'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _reason,
            decoration: const InputDecoration(labelText: 'Reason'),
            minLines: 2,
            maxLines: 4,
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        TextButton(onPressed: _submit, child: const Text('Send')),
      ],
    );
  }
}
