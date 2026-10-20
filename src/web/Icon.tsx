export function Icon({
  name,
  size = 18,
}: {
  name: 'plus' | 'chat' | 'history' | 'arrow' | 'leaf' | 'check' | 'stop';
  size?: number;
}) {
  const paths = {
    plus: 'M12 5v14M5 12h14',
    chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1V11.5a8.5 8.5 0 0 1 17 0Z',
    history: 'M3 12a9 9 0 1 0 3-6.7M3 3v5h5M12 7v5l3 2',
    arrow: 'M12 19V5m-6 6 6-6 6 6',
    leaf: 'M5 19C0 7 10 3 21 3c0 10-4 19-16 16Zm0 0L16 8',
    check: 'm5 12 4 4L19 6',
    stop: 'M6 6h12v12H6z',
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
