import { type I18n } from '@lingui/core';
import { Container } from 'react-email';
import { ShadowText } from 'src/components/ShadowText';

const footerContainerStyle = {
  marginTop: '12px',
};

type FooterProps = {
  i18n: I18n;
};

export const Footer = ({ i18n }: FooterProps) => {
  return (
    <Container style={footerContainerStyle}>
      <ShadowText>{i18n._('Jai OS')}</ShadowText>
    </Container>
  );
};
