# Output Skill — Full-Output Quality Enforcement

Use this skill when the task requires complete, production-grade code output with no omissions, placeholders, or abbreviated patterns. Prevents partial implementations.

## Use when
- Generating complete implementations that will be used directly without further editing.
- The user requests "full code," "complete implementation," or "production-ready" output.
- Code generation tasks where placeholder comments would be unacceptable.
- Any task where "for brevity" shortcuts would leave the output broken.

## Core Principle
Treat every task as production-critical. A partial output is a broken output. There is no acceptable middle ground between complete and incomplete code.

## Prohibited Output Patterns
- `// ...rest follows same pattern`
- `// TODO: implement`
- `/* ... */` placeholder blocks
- `// for brevity`
- `// similar to above`
- Skeleton implementations when full code was requested.
- Prose descriptions substituting for actual code.
- Truncated function bodies.
- Incomplete import lists.

## Process Workflow
1. Identify the total number of deliverables expected (functions, components, files).
2. Generate each one completely before moving to the next.
3. Cross-check the output against the original request.
4. Ensure all imports are present and all referenced variables are defined.

## Handling Long Outputs
- When approaching context or token limits, stop at a natural breakpoint (end of function, end of component).
- Insert a pause marker: `<!-- CONTINUE: [description of what comes next] -->`.
- Do not compress, summarize, or skip any sections.
- On resumption, continue exactly from the pause marker without recapping.

## Verification Checklist (apply before responding)
- [ ] All requested functions/components are present.
- [ ] No placeholder comments remain.
- [ ] All imports are included.
- [ ] All referenced types and interfaces are defined.
- [ ] Error states and edge cases are handled.
- [ ] The code runs without modification.

## Deliverable
- 100% complete, immediately runnable code.
- No placeholder text, comments, or TODO markers.
- Every requested feature implemented.
