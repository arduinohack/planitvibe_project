import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/plan_template.dart';
import '../models/published_template.dart';
import '../providers/plan_provider.dart';
import '../providers/user_provider.dart';
import '../utils/plus_upgrade.dart';
import 'login_screen.dart';
import 'plan_detail_screen.dart';
import 'publish_template_screen.dart';

class TemplatesScreen extends StatefulWidget {
  const TemplatesScreen({super.key});

  @override
  State<TemplatesScreen> createState() => _TemplatesScreenState();
}

class _TemplatesScreenState extends State<TemplatesScreen> {
  List<PublishedTemplateCard> _published = const [];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final status = await planProvider.fetchTemplates(userProvider.token);
    final owned = status == 401
        ? null
        : await planProvider.fetchOwnedPublishedTemplates(userProvider.token);
    if (!mounted) return;
    setState(() {
      _published = owned != null && owned.status == 200
          ? owned.templates
          : const [];
    });
    if (status == 401 || owned?.status == 401) {
      await _endSession(userProvider, planProvider, navigator);
    }
  }

  PublishedTemplateCard? _publishedFor(PlanTemplate template) {
    final source = template.sourcePlanId.trim();
    if (source.isEmpty) return null;
    for (final card in _published) {
      if (card.sourcePlanId == source) return card;
    }
    return null;
  }

  Future<void> _publish(PlanTemplate template) async {
    final planId = template.sourcePlanId.trim();
    if (planId.isEmpty) return;
    final existing = _publishedFor(template);
    final city = existing != null && existing.city.trim().isNotEmpty
        ? existing.city.trim()
        : template.destination.trim();
    final description = existing != null
        ? existing.description
        : template.description.replaceAll(RegExp(r'[\r\n]+'), ' ').trim();
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (context) => PublishTemplateScreen(
          planId: planId,
          initialTitle: existing != null && existing.title.trim().isNotEmpty
              ? existing.title
              : template.name,
          initialDescription: description,
          initialCity: city.length <= 60 ? city : '',
          initialTripLength: existing != null && existing.tripLength > 0
              ? existing.tripLength
              : template.tripLengthDays,
          initialVibe: existing?.vibe ?? '',
          initialCover: existing?.coverImage ?? '',
        ),
      ),
    );
    if (changed == true && mounted) await _load();
  }

  Future<void> _unpublish(PublishedTemplateCard card) async {
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.unpublishTemplate(
      templateId: card.id,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession(userProvider, planProvider, navigator);
      return;
    }
    if (result.status != 200) {
      messenger.showSnackBar(
        SnackBar(
          content: Text(result.error ?? 'Could not unpublish this template'),
        ),
      );
      return;
    }
    messenger.showSnackBar(const SnackBar(content: Text('Unpublished')));
    await _load();
  }

  Future<void> _endSession(
    UserProvider userProvider,
    PlanProvider planProvider,
    NavigatorState navigator,
  ) async {
    planProvider.clearPlans();
    await userProvider.logout();
    if (!mounted) return;
    navigator.pushAndRemoveUntil(
      MaterialPageRoute(builder: (context) => const LoginScreen()),
      (route) => false,
    );
  }

  Future<void> _newFromTemplate(PlanTemplate template) async {
    final request = await showDialog<_NewPlanRequest>(
      context: context,
      builder: (dialogContext) => _NewFromTemplateDialog(templateName: template.name),
    );
    if (request == null || !mounted) return;
    final userProvider = Provider.of<UserProvider>(context, listen: false);
    final planProvider = Provider.of<PlanProvider>(context, listen: false);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final result = await planProvider.createPlanFromTemplate(
      templateId: template.id,
      name: request.name,
      startDate: request.startDate,
      token: userProvider.token,
    );
    if (!mounted) return;
    if (result.status == 401) {
      await _endSession(userProvider, planProvider, navigator);
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
        SnackBar(content: Text(result.error ?? 'Could not create this plan')),
      );
      return;
    }
    await userProvider.loadPlanAccess();
    if (!mounted) return;
    await navigator.push(
      MaterialPageRoute(
        builder: (context) => PlanDetailScreen(plan: created),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Templates')),
      body: Consumer<PlanProvider>(
        builder: (context, planProvider, _) {
          if (planProvider.templatesLoading && planProvider.templates.isEmpty) {
            return const Center(child: CircularProgressIndicator());
          }
          if (planProvider.templatesError != null && planProvider.templates.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  planProvider.templatesError!,
                  textAlign: TextAlign.center,
                ),
              ),
            );
          }
          if (planProvider.templates.isEmpty) {
            return const Center(
              child: Text(
                'No templates yet',
                style: TextStyle(fontSize: 20),
                textAlign: TextAlign.center,
              ),
            );
          }
          return ListView(
            children: [
              for (final template in planProvider.templates)
                _templateCard(template),
            ],
          );
        },
      ),
    );
  }

  Widget _templateCard(PlanTemplate template) {
    final published = _publishedFor(template);
    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ListTile(
            title: Text(template.name),
            subtitle: template.description.trim().isEmpty
                ? null
                : Text(template.description.trim()),
          ),
          Align(
            alignment: Alignment.centerLeft,
            child: Wrap(
              children: [
                TextButton(
                  onPressed: () => _newFromTemplate(template),
                  child: const Text('New from template'),
                ),
                if (template.sourcePlanId.trim().isNotEmpty)
                  TextButton(
                    onPressed: () => _publish(template),
                    child: const Text('Publish'),
                  ),
                if (published != null && published.published)
                  TextButton(
                    onPressed: () => _unpublish(published),
                    child: const Text('Unpublish'),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _NewPlanRequest {
  final String name;
  final String startDate;

  const _NewPlanRequest({required this.name, required this.startDate});
}

class _NewFromTemplateDialog extends StatefulWidget {
  final String templateName;

  const _NewFromTemplateDialog({required this.templateName});

  @override
  State<_NewFromTemplateDialog> createState() => _NewFromTemplateDialogState();
}

class _NewFromTemplateDialogState extends State<_NewFromTemplateDialog> {
  late final TextEditingController _nameController;
  DateTime? _start;
  String? _error;

  @override
  void initState() {
    super.initState();
    _nameController = TextEditingController(text: widget.templateName);
  }

  @override
  void dispose() {
    _nameController.dispose();
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
    final name = _nameController.text.trim();
    final start = _start;
    if (name.isEmpty) {
      setState(() => _error = 'Name is required.');
      return;
    }
    if (start == null) {
      setState(() => _error = 'Choose a start date.');
      return;
    }
    Navigator.pop(
      context,
      _NewPlanRequest(name: name, startDate: _dayLabel(start)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final start = _start;
    return AlertDialog(
      title: const Text('New from template'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _nameController,
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
              Text(_error!),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        TextButton(
          onPressed: _submit,
          child: const Text('Create'),
        ),
      ],
    );
  }
}
