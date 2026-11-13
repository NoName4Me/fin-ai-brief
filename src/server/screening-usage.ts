// Integer allocation keeps the sum across members/periods equal to the paid request,
// including small token counts and batches crossing a publication cutoff.
export function screeningTokenShare(
  column: 'input_tokens' | 'output_tokens',
  call = 'mc',
  member = 'sc',
) {
  const value = `coalesce(${call}.${column},0)`;
  return `(${value}/${member}.batch_size + CASE WHEN ${member}.member_index < ${value}%${member}.batch_size THEN 1 ELSE 0 END)`;
}
