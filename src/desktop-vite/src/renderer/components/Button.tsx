export interface Props {
  label: string;
  onClick?: () => void;
}

export default function Button(props: Props) {
  return (
    <button className="" onClick={props.onClick || (() => {})}>
      {props.label}
    </button>
  );
}
